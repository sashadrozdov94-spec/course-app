import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RbacService } from '../../rbac/rbac.service.js';
import type { User } from '../entities/user.entity.js';
import { USERS_ACTIONS, USERS_PERMISSION } from '../shared/users-permission.js';
import { UserRateLimits } from '../shared/user-rate-limits.service.js';
import { UsersService } from '../users.service.js';
import {
  buildProfileView,
  fieldsForActions,
  type ProfileField,
  type ProfileView,
  SELF_PROFILE_FIELDS,
} from './dto/profile-view.js';

/**
 * Кто какой профиль видит и в каком объёме.
 *
 * Вся логика доступа собрана здесь, а не в контроллере: контроллеру
 * остаётся принять запрос и отдать ответ.
 */
@Injectable()
export class ProfileReadService {
  // Отдельный журнал п. 1.5: viewer, target, результат. В базу не пишем —
  // в ТЗ этот пункт помечен как необязательный, а строк тут будет много:
  // каждый просмотр профиля. Понадобится история — есть готовый образец
  // в RbacAuditService.
  private readonly logger = new Logger('ProfileRead');

  constructor(
    private readonly usersService: UsersService,
    private readonly rbac: RbacService,
    private readonly limits: UserRateLimits,
  ) {}

  /**
   * Профиль пользователя targetId глазами viewer.
   *
   * Порядок проверок важен и отличается от порядка в ТЗ: существование
   * пользователя проверяется ПОСЛЕ права на просмотр. Иначе чужой без прав
   * получал бы 404 на несуществующие номера и 403 на существующие — и по
   * разнице ответов перебирал бы базу, не имея на неё никаких прав.
   */
  async view(viewer: User, targetId: string): Promise<ProfileView> {
    // Сценарий 1: свой профиль. Проверять RBAC незачем — и это же защита
    // от IDOR (п. 1.6): «свой» определяется по номеру из токена, а не по
    // номеру из адреса.
    if (viewer.id === targetId) {
      this.log(viewer.id, targetId, 200, 'self');
      return buildProfileView(viewer, new Set(SELF_PROFILE_FIELDS));
    }

    // Дальше — только чужие профили. Считаем их отдельным лимитом
    this.limits.hitForeignRead(viewer.id);

    // Что вообще позволяют роли этого человека делать с профилями
    const actions = await this.rbac.allowedActions(viewer, USERS_PERMISSION);

    // Сценарий 3: базового права users.read нет — дальше не идём.
    // Действия вроде read_email без него не работают: это надстройка над
    // просмотром, а не самостоятельный доступ.
    if (!actions.has(USERS_ACTIONS.Read)) {
      this.log(viewer.id, targetId, 403, 'нет права users.read');
      throw new ForbiddenException('Нет прав на просмотр чужого профиля');
    }

    const target = await this.usersService.findById(targetId);

    if (!target) {
      this.log(viewer.id, targetId, 404, 'пользователь не найден');
      throw new NotFoundException('Пользователь не найден');
    }

    // Сценарий 2: отдаём ровно те поля, которые открыли выданные действия
    const fields: Set<ProfileField> = fieldsForActions(actions);

    this.log(viewer.id, targetId, 200, [...fields].join(','));

    return buildProfileView(target, fields);
  }

  private log(
    viewerUserId: string,
    targetUserId: string,
    statusCode: number,
    details: string,
  ): void {
    this.logger.log(
      `viewer=${viewerUserId} target=${targetUserId} → ${statusCode} (${details})`,
    );
  }
}
