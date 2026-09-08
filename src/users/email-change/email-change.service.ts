import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  VerificationChannel,
  VerificationPurpose,
} from '../../auth/entities/email-verification.entity.js';
import { VerificationService } from '../../auth/verification.service.js';
import { isUniqueViolation } from '../../common/postgres-errors.js';
import { AuthSettingsService } from '../../settings/auth-settings.service.js';
import type { User } from '../entities/user.entity.js';
import { UserRateLimits } from '../shared/user-rate-limits.service.js';
import { UsersService } from '../users.service.js';
import type { ConfirmEmailChangeDto } from './dto/email-change.dto.js';

/** Ответ на запрос смены почты (п. 1.3.2 ТЗ). */
export interface EmailChangeStarted {
  requiresConfirmation: true;
  challengeId: string;
  channel: VerificationChannel;
  expiresAt: Date;
}

/** Ответ на подтверждение смены почты (п. 1.3.3 ТЗ). */
export interface EmailChangeConfirmed {
  changed: true;
  email: string;
}

/**
 * Смена почты: два шага, три входа.
 *
 * Первый шаг — запрос: код или ссылка уходит на НОВЫЙ адрес. Второй —
 * подтверждение, кодом (вариант A) или переходом по ссылке (вариант B).
 *
 * Администратора здесь нет: он меняет почту напрямую через PATCH, ему
 * подтверждать нечего — он уже доказал, кто он, входом.
 */
@Injectable()
export class EmailChangeService {
  private readonly logger = new Logger('EmailChange');

  constructor(
    private readonly usersService: UsersService,
    private readonly verification: VerificationService,
    private readonly settings: AuthSettingsService,
    private readonly limits: UserRateLimits,
  ) {}

  /** Шаг 1: запросить смену (п. 1.3.2 ТЗ). Только Self. */
  async request(
    actor: User,
    targetId: string,
    newEmail: string,
  ): Promise<EmailChangeStarted> {
    // Защита от IDOR. Админ меняет почту напрямую через PATCH,
    // ему этот сценарий с кодами не нужен и недоступен.
    if (actor.id !== targetId) {
      this.log(actor.id, targetId, 403, 'запрос смены чужой почты');
      throw new ForbiddenException('Нельзя менять чужую почту');
    }

    const existing = await this.usersService.findByEmail(newEmail);

    if (existing) {
      this.log(actor.id, targetId, 409, 'почта занята');
      throw new ConflictException('Эта почта уже занята');
    }

    // Отдельный счётчик: ниже отправляется письмо на указанный адрес, и
    // без него приложением можно было бы завалить чужой ящик.
    this.limits.hitEmailChange(actor.id);

    // Чем подтверждать — решает сервер, той же настройкой, что управляет
    // регистрацией и входом (п. 1.3.2 ТЗ: «или выбирается сервером»).
    const { verificationChannel } = await this.settings.get();

    // Четвёртым аргументом — новый адрес: письмо уходит на него, а не на
    // текущую почту. Сам адрес сохраняется в попытке, потому что на шаге
    // подтверждения через десять минут взять его будет уже неоткуда.
    const challenge = await this.verification.start(
      actor,
      VerificationPurpose.EmailChange,
      verificationChannel,
      newEmail,
    );

    this.log(actor.id, targetId, 200, 'запрошена смена почты');

    return {
      requiresConfirmation: true,
      challengeId: challenge.attemptId,
      channel: challenge.channel,
      expiresAt: challenge.expiresAt,
    };
  }

  /** Шаг 2, вариант A: подтверждение кодом. */
  async confirmByCode(
    actor: User,
    targetId: string,
    dto: ConfirmEmailChangeDto,
  ): Promise<EmailChangeConfirmed> {
    if (actor.id !== targetId) {
      this.log(actor.id, targetId, 403, 'подтверждение чужой смены');
      throw new ForbiddenException('Нельзя менять чужую почту');
    }

    // Третьим аргументом — назначение: код, выданный для входа, здесь не
    // сработает, и попытка на нём не сгорит. Срок, число попыток и
    // гашение кода — внутри VerificationService.
    const confirmed = await this.verification.confirmOtp(
      dto.challengeId,
      dto.code,
      [VerificationPurpose.EmailChange],
    );

    // Номер попытки видно клиенту, поэтому проверяем, что она своя.
    // Иначе чужим challengeId можно было бы поменять почту себе.
    if (confirmed.userId !== actor.id) {
      this.log(actor.id, targetId, 403, 'чужая попытка подтверждения');
      throw new ForbiddenException('Эта попытка принадлежит другому человеку');
    }

    return this.apply(confirmed, 'код');
  }

  /**
   * Шаг 2, вариант B: подтверждение по ссылке.
   *
   * Входа не требует, и это не упущение. Письмо уходит на НОВЫЙ адрес, а
   * его человек откроет там, где ему удобно читать почту, — в телефоне, в
   * другом браузере. Сессии там нет: ни cookie, ни чего-либо ещё, что
   * браузер подставил бы сам. Доказательством служит сам токен, пришедший
   * в тот самый ящик, ради которого затевалась смена.
   *
   * Кто заказывал смену, берётся не из запроса, а из попытки в базе:
   * подтвердить чужую смену этой ссылкой нельзя, только ту, ради которой
   * токен и выдан. Так же устроено подтверждение регистрации.
   */
  async confirmByLink(token: string): Promise<EmailChangeConfirmed> {
    const confirmed = await this.verification.confirmMagicLink(token, [
      VerificationPurpose.EmailChange,
    ]);

    return this.apply(confirmed, 'ссылка');
  }

  /**
   * Общая часть обоих подтверждений: записать новый адрес.
   *
   * Актор здесь — тот, кому выдавалась попытка. Для кода это заодно уже
   * проверенный владелец сессии, для ссылки — единственный источник правды.
   */
  private async apply(
    confirmed: { userId: string; newEmail: string | null },
    via: string,
  ): Promise<EmailChangeConfirmed> {
    const userId = confirmed.userId;

    if (!confirmed.newEmail) {
      // Такого быть не должно: адрес пишется при создании попытки
      this.log(userId, userId, 400, 'в попытке нет адреса');
      throw new BadRequestException('Запрос на смену почты повреждён');
    }

    // Занятость перепроверяем: между запросом и подтверждением проходит
    // до десяти минут, за это время адрес могли зарегистрировать. Код при
    // этом уже потрачен — смену придётся начинать заново, зато двух
    // аккаунтов с одной почтой не появится.
    const taken = await this.usersService.findByEmail(confirmed.newEmail);

    if (taken && taken.id !== userId) {
      this.log(userId, userId, 409, `почта занята (${via})`);
      throw new ConflictException('Эта почта уже занята');
    }

    // Записываем адрес и отмечаем его подтверждённым: человек только что
    // доказал, что читает этот ящик. status намеренно не трогаем —
    // заблокированный не должен разблокироваться сменой почты.
    try {
      await this.usersService.updateProfile(userId, {
        email: confirmed.newEmail,
        emailVerifiedAt: new Date(),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.log(userId, userId, 409, `почта занята (${via})`);
        throw new ConflictException('Эта почта уже занята');
      }
      throw error;
    }

    this.log(userId, userId, 200, `почта изменена (${via})`);

    return { changed: true, email: confirmed.newEmail };
  }

  /**
   * Журнал п. 1.5. Пишем только имя поля и результат — сами адреса в лог
   * не попадают: это персональные данные.
   */
  private log(
    actorUserId: string,
    targetUserId: string,
    statusCode: number,
    details: string,
  ): void {
    this.logger.log(
      `actor=${actorUserId} target=${targetUserId} ` +
        `field=email → ${statusCode} (${details})`,
    );
  }
}
