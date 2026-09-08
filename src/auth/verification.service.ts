import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';
import type { Env } from '../config/env.schema.js';
import { MailService } from '../mail/mail.service.js';
import { magicLinkLetter, otpLetter } from '../mail/mail.templates.js';
import type { User } from '../users/entities/user.entity.js';
import {
  EmailVerification,
  VerificationChannel,
  VerificationPurpose,
} from './entities/email-verification.entity.js';

// Что вернуть клиенту после выдачи кода/ссылки
export interface VerificationStarted {
  attemptId: string;
  channel: VerificationChannel;
  expiresAt: Date;
}

// Результат успешной проверки кода или ссылки.
// purpose важен: от него зависит, что делать дальше — активировать
// аккаунт (регистрация) или выдать токены (вход).
export interface VerificationConfirmed {
  userId: string;
  purpose: VerificationPurpose;
  /** Заполнен только для purpose = email_change. */
  newEmail: string | null;
}

/**
 * Куда ведёт ссылка из письма — зависит от того, зачем выдан код.
 *
 * Один адрес на все сценарии не годится: обработчик регистрации и входа
 * намеренно сужен до своих назначений, и подмешивать туда смену почты
 * значило бы размывать эту границу обратно.
 */
const CONFIRM_PATHS: Record<VerificationPurpose, string> = {
  [VerificationPurpose.Registration]: '/auth/confirm',
  [VerificationPurpose.Login]: '/auth/confirm',
  [VerificationPurpose.EmailChange]: '/users/email-change/confirm',
  [VerificationPurpose.AccountDeletion]: '/users/deletion/confirm',
};

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    @InjectRepository(EmailVerification)
    private readonly repository: Repository<EmailVerification>,
    private readonly config: ConfigService<Env, true>,
    private readonly mailService: MailService,
  ) {}

  /**
   * Выдать новый код или ссылку и отправить письмо.
   * Старые неиспользованные попытки для того же дела гасим, чтобы работал
   * только последний присланный код.
   */
  async start(
    user: User,
    purpose: VerificationPurpose,
    channel: VerificationChannel,
    /**
     * Куда слать письмо, если не на текущую почту пользователя.
     * Нужен для смены адреса: код должен прийти на НОВЫЙ ящик — это и есть
     * доказательство, что человек им владеет.
     */
    newEmail?: string,
  ): Promise<VerificationStarted> {
    await this.consumeOldAttempts(user.id, purpose);

    const ttlSeconds = this.config.get('OTP_TTL_SECONDS', { infer: true });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    // Сам секрет: короткий код или длинный токен для ссылки
    const secret =
      channel === VerificationChannel.Otp
        ? this.generateOtp()
        : this.generateToken();

    // В базу кладём ТОЛЬКО отпечаток секрета
    const verification = await this.repository.save(
      this.repository.create({
        userId: user.id,
        purpose,
        channel,
        newEmail: newEmail ?? null,
        secretHash: this.hashSecret(secret),
        expiresAt,
        attempts: 0,
        maxAttempts: this.config.get('OTP_MAX_ATTEMPTS', { infer: true }),
        consumedAt: null,
        lastSentAt: now,
      }),
    );

    await this.sendLetter(
      newEmail ?? user.email,
      channel,
      secret,
      ttlSeconds,
      purpose,
    );

    return {
      attemptId: verification.id,
      channel,
      expiresAt,
    };
  }

  /**
   * Повторная отправка. Не чаще, чем раз в OTP_RESEND_COOLDOWN_SECONDS.
   * Секрет генерируем новый — старый мы не знаем, у нас только отпечаток.
   */
  async resend(attemptId: string, user: User): Promise<VerificationStarted> {
    const verification = await this.findActive(attemptId);
    const cooldown = this.config.get('OTP_RESEND_COOLDOWN_SECONDS', {
      infer: true,
    });
    const secondsSinceLast =
      (Date.now() - verification.lastSentAt.getTime()) / 1000;

    if (secondsSinceLast < cooldown) {
      const wait = Math.ceil(cooldown - secondsSinceLast);
      throw new BadRequestException(
        `Повторная отправка возможна через ${wait} секунд`,
      );
    }

    // Адрес берём из самой попытки: повтор должен уйти туда же, куда и
    // первое письмо, иначе код придёт не в тот ящик.
    return this.start(
      user,
      verification.purpose,
      verification.channel,
      verification.newEmail ?? undefined,
    );
  }

  /**
   * Проверить код (OTP). Возвращает, чей это код и зачем он выдавался.
   * Каждая неудачная попытка увеличивает счётчик; кончились попытки — код мёртв.
   */
  async confirmOtp(
    attemptId: string,
    code: string,
    /**
     * Зачем разрешено подтверждать этот код в этом месте.
     *
     * Коды всех видов лежат в одной таблице и внешне неотличимы, поэтому
     * код, выданный для смены почты, можно предъявить на входе — и
     * наоборот. Проверяем ДО расхода попытки: чужой сценарий не должен
     * ни срабатывать, ни сжигать чужой код.
     */
    allowedPurposes?: VerificationPurpose[],
  ): Promise<VerificationConfirmed> {
    const verification = await this.findActive(attemptId);

    this.ensurePurposeAllowed(verification.purpose, allowedPurposes);

    if (verification.channel !== VerificationChannel.Otp) {
      throw new BadRequestException('Эта попытка подтверждается по ссылке');
    }

    if (verification.attempts >= verification.maxAttempts) {
      throw new BadRequestException('Превышено число попыток ввода кода');
    }

    if (verification.secretHash !== this.hashSecret(code)) {
      // Счётчик увеличиваем в базе, а не в памяти: перезапуск его не сбросит
      await this.repository.increment({ id: verification.id }, 'attempts', 1);
      const left = verification.maxAttempts - verification.attempts - 1;
      throw new BadRequestException(
        left > 0
          ? `Неверный код. Осталось попыток: ${left}`
          : 'Неверный код. Попытки закончились',
      );
    }

    await this.markConsumed(verification.id);
    return {
      userId: verification.userId,
      purpose: verification.purpose,
      newEmail: verification.newEmail,
    };
  }

  /** Проверить токен из ссылки (magic link). */
  async confirmMagicLink(
    token: string,
    allowedPurposes?: VerificationPurpose[],
  ): Promise<VerificationConfirmed> {
    const secretHash = this.hashSecret(token);
    const verification = await this.repository.findOne({
      where: { secretHash, channel: VerificationChannel.MagicLink },
    });

    if (!verification) {
      throw new BadRequestException('Ссылка недействительна');
    }
    if (verification.consumedAt) {
      throw new BadRequestException('Ссылкой уже воспользовались');
    }
    if (verification.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Срок действия ссылки истёк');
    }

    this.ensurePurposeAllowed(verification.purpose, allowedPurposes);

    await this.markConsumed(verification.id);
    return {
      userId: verification.userId,
      purpose: verification.purpose,
      newEmail: verification.newEmail,
    };
  }

  /** Чей это код — нужно для повторной отправки письма. */
  async getUserId(attemptId: string): Promise<string> {
    const verification = await this.findActive(attemptId);
    return verification.userId;
  }

  /**
   * Код выдавался не для того, зачем его сейчас предъявляют.
   *
   * Наружу говорим ровно то же, что и про неверный код: по разнице ответов
   * не должно быть видно, какой именно код лежит за этим номером попытки.
   */
  private ensurePurposeAllowed(
    purpose: VerificationPurpose,
    allowed?: VerificationPurpose[],
  ): void {
    if (!allowed || allowed.includes(purpose)) {
      return;
    }

    this.logger.warn(
      `Попытка подтвердить код с назначением "${purpose}" не в том сценарии`,
    );
    throw new BadRequestException('Код недействителен');
  }

  // ───────── внутренние помощники ─────────

  /** Шестизначный код. randomInt из crypto, а НЕ Math.random. */
  private generateOtp(): string {
    const length = this.config.get('OTP_LENGTH', { infer: true });
    const max = 10 ** length;
    return String(randomInt(0, max)).padStart(length, '0');
  }

  /** Длинный случайный токен для ссылки: 32 байта в виде текста. */
  private generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Отпечаток секрета. SHA-256 достаточно: секрет живёт минуты. */
  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  private async sendLetter(
    email: string,
    channel: VerificationChannel,
    secret: string,
    ttlSeconds: number,
    purpose: VerificationPurpose,
  ): Promise<void> {
    const ttlMinutes = Math.round(ttlSeconds / 60);

    if (channel === VerificationChannel.Otp) {
      await this.mailService.send(otpLetter(email, secret, ttlMinutes));
      return;
    }

    const appUrl = this.config.get('APP_URL', { infer: true });
    const link = `${appUrl}${CONFIRM_PATHS[purpose]}?token=${secret}`;
    await this.mailService.send(magicLinkLetter(email, link, ttlMinutes));
  }

  private async findActive(attemptId: string): Promise<EmailVerification> {
    const verification = await this.repository.findOne({
      where: { id: attemptId },
    });

    if (!verification) {
      throw new NotFoundException('Попытка подтверждения не найдена');
    }
    if (verification.consumedAt) {
      throw new BadRequestException('Этот код уже использован');
    }
    if (verification.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Срок действия кода истёк');
    }

    return verification;
  }

  private async markConsumed(id: string): Promise<void> {
    await this.repository.update({ id }, { consumedAt: new Date() });
  }

  /** Гасим прежние неиспользованные попытки: рабочим остаётся только новый код. */
  private async consumeOldAttempts(
    userId: string,
    purpose: VerificationPurpose,
  ): Promise<void> {
    await this.repository.update(
      // IsNull() — это способ TypeORM сказать в SQL "WHERE consumedAt IS NULL"
      { userId, purpose, consumedAt: IsNull() },
      { consumedAt: new Date() },
    );
  }
}
