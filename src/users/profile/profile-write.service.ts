import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { isUniqueViolation } from '../../common/postgres-errors.js';
import { RbacService } from '../../rbac/rbac.service.js';
import type { User } from '../entities/user.entity.js';
import { USERS_ACTIONS, USERS_PERMISSION } from '../shared/users-permission.js';
import { UserRateLimits } from '../shared/user-rate-limits.service.js';
import { UsersService } from '../users.service.js';
import {
  buildProfileView,
  fieldsForActions,
  type ProfileView,
  SELF_PROFILE_FIELDS,
} from './dto/profile-view.js';
import {
  PROFILE_UPDATE_POLICY,
  toColumnPatch,
  type UpdatableField,
  type UpdateProfileDto,
} from './dto/update-profile.dto.js';

/** Ответ, когда менять поля можно, а читать их обратно — нет. */
export interface UpdateAck {
  updated: UpdatableField[];
}

/**
 * Изменение профиля: PATCH /users/{userId}.
 *
 * Брат ProfileReadService: там кто что видит, здесь кто что меняет.
 * Порядок проверок такой же — право раньше существования, чтобы по разнице
 * между 403 и 404 нельзя было перебирать чужие номера.
 *
 * Смена почты сюда НЕ входит: у неё своя фича со своим сервисом. Раньше
 * оба сценария жили в одном классе, и контроллер смены почты вынужден был
 * просить сервис профиля — связь, которой быть не должно.
 */
@Injectable()
export class ProfileWriteService {
  private readonly logger = new Logger('ProfileWrite');

  constructor(
    private readonly usersService: UsersService,
    private readonly rbac: RbacService,
    private readonly limits: UserRateLimits,
  ) {}

  async update(
    actor: User,
    targetId: string,
    patch: UpdateProfileDto,
  ): Promise<ProfileView | UpdateAck> {
    // Считаем ДО проверок: отклонённые попытки тоже расходуют бюджет,
    // иначе перебор запрещённых полей был бы бесплатным (п. 1.4 ТЗ).
    this.limits.hitProfileWrite(actor.id);

    const isSelf = actor.id === targetId;
    const requested = Object.keys(patch) as UpdatableField[];

    // 1. Что этому человеку вообще позволено делать с профилями.
    //    Для своего профиля RBAC не спрашиваем: право менять себя не
    //    выдают и не отбирают. «Свой» берётся из токена, а не из адреса —
    //    это защита от IDOR (п. 1.6).
    const actions = isSelf
      ? new Set<string>()
      : await this.rbac.allowedActions(actor, USERS_PERMISSION);

    if (!isSelf && !actions.has(USERS_ACTIONS.Update)) {
      this.deny(actor.id, targetId, requested, 'нет права users.update');
      throw new ForbiddenException('Нет прав на изменение чужого профиля');
    }

    // 2. Поля, которые этой роли можно трогать
    const allowed: readonly UpdatableField[] = isSelf
      ? PROFILE_UPDATE_POLICY.self
      : PROFILE_UPDATE_POLICY.update;

    const forbidden = requested.filter((field) => !allowed.includes(field));

    if (forbidden.length > 0) {
      this.deny(actor.id, targetId, forbidden, 'поля запрещены');

      // Отдельное сообщение про почту: по ТЗ это не «нельзя никогда», а
      // «не здесь». Человек должен понять, куда идти дальше.
      if (isSelf && forbidden.includes('email')) {
        throw new ForbiddenException(
          'Почту нельзя изменить напрямую: нужен запрос на смену с подтверждением',
        );
      }

      throw new ForbiddenException(
        `Нет прав на изменение полей: ${forbidden.join(', ')}`,
      );
    }

    // 3. Одна запись в базу. Существование проверяем по числу изменённых
    //    строк, а не отдельным SELECT: на один запрос меньше, и заодно
    //    ловится случай, когда пользователя удалили только что.
    let affected: number;

    try {
      affected = await this.usersService.updateProfile(
        targetId,
        toColumnPatch(patch),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.deny(actor.id, targetId, requested, 'почта занята');
        throw new ConflictException('Эта почта уже занята');
      }
      throw error;
    }

    if (affected === 0) {
      this.log(actor.id, targetId, requested, 404, 'пользователь не найден');
      throw new NotFoundException('Пользователь не найден');
    }

    this.log(actor.id, targetId, requested, 200, 'сохранено');

    return this.buildAnswer(targetId, isSelf, actions, requested);
  }

  /**
   * Что вернуть в ответе: по ТЗ это обновлённый профиль, но только из полей,
   * которые актору разрешено ЧИТАТЬ. Прав на чтение может не быть вовсе —
   * тогда, как и предусмотрено ТЗ, отдаём подтверждение успеха.
   */
  private async buildAnswer(
    targetId: string,
    isSelf: boolean,
    actions: ReadonlySet<string>,
    updated: UpdatableField[],
  ): Promise<ProfileView | UpdateAck> {
    const readable = isSelf
      ? new Set(SELF_PROFILE_FIELDS)
      : fieldsForActions(actions);

    if (readable.size === 0) {
      return { updated };
    }

    // Перечитываем: в ответе должны быть новые значения, а вместе с ними
    // и свежий updatedAt, который проставила сама база.
    const fresh = await this.usersService.findById(targetId);

    if (!fresh) {
      // Успели удалить между UPDATE и SELECT — редкость, но не ошибка
      return { updated };
    }

    return buildProfileView(fresh, readable);
  }

  private deny(
    actorUserId: string,
    targetUserId: string,
    fields: UpdatableField[],
    details: string,
  ): void {
    this.log(actorUserId, targetUserId, fields, 403, details);
  }

  /**
   * Журнал п. 1.5: кто, кого, какие поля, результат.
   * Только ИМЕНА полей — значения в лог не попадают никогда.
   */
  private log(
    actorUserId: string,
    targetUserId: string,
    fields: UpdatableField[],
    statusCode: number,
    details: string,
  ): void {
    this.logger.log(
      `actor=${actorUserId} target=${targetUserId} ` +
        `fields=${fields.join(',') || '-'} → ${statusCode} (${details})`,
    );
  }
}
