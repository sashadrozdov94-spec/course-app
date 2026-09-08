import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { VerificationPurpose } from '../../auth/entities/email-verification.entity.js';
import { VerificationService } from '../../auth/verification.service.js';
import type { Env } from '../../config/env.schema.js';
import { RbacService } from '../../rbac/rbac.service.js';
import { AuthSettingsService } from '../../settings/auth-settings.service.js';
import type { User } from '../entities/user.entity.js';
import { USERS_ACTIONS, USERS_PERMISSION } from '../shared/users-permission.js';
import { UserRateLimits } from '../shared/user-rate-limits.service.js';
import { UsersService } from '../users.service.js';
import type { ConfirmDeletionDto } from './dto/delete-user.dto.js';

/** Себе — сначала подтверждение (п. 1.3.1 ТЗ). */
export interface DeletionRequiresConfirmation {
  requiresConfirmation: true;
  challengeId: string;
  channel: string;
  expiresAt: Date;
}

/** Готово: строка удалена. */
export interface DeletionDone {
  deleted: true;
  userId: string;
}

/**
 * Удаление пользователя.
 *
 * Удаляем строку физически — так решено при разборе ТЗ. Коды подтверждения
 * и связка с ролями уходят каскадом, записи журналов остаются: у них нет
 * внешнего ключа на пользователя, и это правильно — история не должна
 * исчезать вместе с тем, о ком она.
 *
 * Отдельно про «отозвать сессии и refresh-токены» из ТЗ: буквально отзывать
 * нечего, refresh-токены на сервере не хранятся. Но и не нужно: JwtAuthGuard
 * и /auth/refresh на каждом запросе ищут пользователя в базе. Строки нет —
 * оба немедленно отвечают 401, сколько бы живых токенов ни осталось на
 * руках. Требование выполняется, просто другим механизмом.
 */
@Injectable()
export class DeletionService {
  // Журнал п. 1.5: актор, цель, тип операции, результат.
  // Удаляемых данных здесь нет и быть не может — только идентификаторы.
  private readonly logger = new Logger('AccountDeletion');

  constructor(
    private readonly usersService: UsersService,
    private readonly rbac: RbacService,
    private readonly verification: VerificationService,
    private readonly settings: AuthSettingsService,
    private readonly limits: UserRateLimits,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * DELETE /users/{userId} — запрос на удаление.
   *
   * Себе — только через подтверждение по почте: ТЗ требует этого прямо, и
   * это правильно. Удаление необратимо, а до чужого незалоченного ноутбука
   * добраться проще, чем до чужого почтового ящика.
   *
   * Чужого — сразу, по праву users@delete. Администратор уже доказал, кто
   * он, входом; слать ему код на его же почту смысла нет.
   */
  async request(
    actor: User,
    targetId: string,
    reason?: string,
  ): Promise<DeletionRequiresConfirmation | DeletionDone> {
    const isSelf = actor.id === targetId;

    if (isSelf) {
      // Каждый такой запрос шлёт письмо — считаем отдельным строгим счётчиком
      this.limits.hitDeletion(actor.id);

      const { verificationChannel } = await this.settings.get();

      const challenge = await this.verification.start(
        actor,
        VerificationPurpose.AccountDeletion,
        verificationChannel,
      );

      this.log(actor.id, targetId, 'self', 200, 'запрошено удаление');

      return {
        requiresConfirmation: true,
        challengeId: challenge.attemptId,
        channel: challenge.channel,
        expiresAt: challenge.expiresAt,
      };
    }

    // Право проверяем до существования: иначе по разнице между 403 и 404
    // посторонний перебирал бы чужие номера (та же логика, что в чтении).
    const actions = await this.rbac.allowedActions(actor, USERS_PERMISSION);

    if (!actions.has(USERS_ACTIONS.Delete)) {
      this.log(actor.id, targetId, 'admin', 403, 'нет права users.delete');
      throw new ForbiddenException('Нет прав на удаление пользователя');
    }

    const target = await this.usersService.findById(targetId);

    if (!target) {
      this.log(actor.id, targetId, 'admin', 404, 'пользователь не найден');
      throw new NotFoundException('Пользователь не найден');
    }

    return this.remove(actor.id, target, 'admin', reason);
  }

  /** Подтверждение удаления кодом (вариант A). */
  async confirmByCode(
    actor: User,
    targetId: string,
    dto: ConfirmDeletionDto,
  ): Promise<DeletionDone> {
    // Защита от IDOR: удалить можно только себя, и только себя же
    // подтверждали. Чужого удаляет администратор, без кодов.
    if (actor.id !== targetId) {
      this.log(
        actor.id,
        targetId,
        'self',
        403,
        'подтверждение чужого удаления',
      );
      throw new ForbiddenException('Нельзя удалить чужой аккаунт');
    }

    const confirmed = await this.verification.confirmOtp(
      dto.challengeId,
      dto.code,
      [VerificationPurpose.AccountDeletion],
    );

    if (confirmed.userId !== actor.id) {
      this.log(actor.id, targetId, 'self', 403, 'чужая попытка подтверждения');
      throw new ForbiddenException('Эта попытка принадлежит другому человеку');
    }

    return this.remove(actor.id, actor, 'self');
  }

  /**
   * Подтверждение удаления по ссылке (вариант B).
   *
   * Как и у смены почты, входа не требует: письмо открывают там, где
   * удобно читать почту. Кто заказывал удаление — берётся из попытки в
   * базе, а не из запроса.
   */
  async confirmByLink(token: string): Promise<DeletionDone> {
    const confirmed = await this.verification.confirmMagicLink(token, [
      VerificationPurpose.AccountDeletion,
    ]);

    const target = await this.usersService.findById(confirmed.userId);

    if (!target) {
      // Успели удалить другим способом — считаем, что цель достигнута
      this.log(confirmed.userId, confirmed.userId, 'self', 200, 'уже удалён');
      return { deleted: true, userId: confirmed.userId };
    }

    return this.remove(confirmed.userId, target, 'self');
  }

  /**
   * Сама операция. Одна запись в базу плюс уборка файла.
   *
   * Идемпотентность (п. 1.6): удалилось ноль строк — значит кто-то успел
   * раньше. Это не ошибка, ответ тот же.
   */
  private async remove(
    actorUserId: string,
    target: User,
    kind: 'self' | 'admin',
    reason?: string,
  ): Promise<DeletionDone> {
    await this.removeAvatar(target.avatarUrl);

    const affected = await this.usersService.deleteById(target.id);

    this.log(
      actorUserId,
      target.id,
      kind,
      200,
      affected > 0 ? 'удалён' : 'уже был удалён',
      reason,
    );

    return { deleted: true, userId: target.id };
  }

  /**
   * Убираем фото с диска. Файлы лежат в папке из UPLOAD_DIR.
   *
   * Из значения берём только имя файла: в колонке может оказаться и полная
   * ссылка, и путь с ../.. — а собирать путь из непроверенной строки
   * означало бы дать удалить что угодно на диске.
   */
  private async removeAvatar(avatarUrl: string | null): Promise<void> {
    if (!avatarUrl) {
      return;
    }

    const name = basename(avatarUrl.split('?')[0]);

    if (!name || name === '.' || name === '..') {
      return;
    }

    const dir = this.config.get('UPLOAD_DIR', { infer: true });

    try {
      await unlink(join(dir, name));
    } catch {
      // Файла нет — обычное дело: фото могло лежать по внешней ссылке или
      // быть удалено раньше. Ронять из-за этого удаление аккаунта нельзя.
    }
  }

  private log(
    actorUserId: string,
    targetUserId: string,
    kind: 'self' | 'admin',
    statusCode: number,
    details: string,
    reason?: string,
  ): void {
    // Причину пишем как есть — её вводит сам человек про себя, к удаляемым
    // персональным данным она не относится. Значений PII здесь нет.
    const why = reason ? ` reason="${reason.slice(0, 64)}"` : '';

    this.logger.log(
      `actor=${actorUserId} target=${targetUserId} kind=${kind} ` +
        `→ ${statusCode} (${details})${why}`,
    );
  }
}
