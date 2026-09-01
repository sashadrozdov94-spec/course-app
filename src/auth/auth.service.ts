import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { AuthSettingsService } from '../settings/auth-settings.service.js';
import { User, UserStatus } from '../users/entities/user.entity.js';
import { UsersService } from '../users/users.service.js';
import {
  type AuditRecord,
  AuditService,
  type RequestContext,
} from './audit.service.js';
import type { ConfirmOtpDto, ResendDto } from './dto/confirm.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import { AuthAuditEvent } from './entities/auth-audit-log.entity.js';
import { VerificationPurpose } from './entities/email-verification.entity.js';
import { PasswordService } from './password.service.js';
import { VerificationService } from './verification.service.js';

// Код ошибки PostgreSQL «нарушено требование уникальности»
const PG_UNIQUE_VIOLATION = '23505';

export interface RegisterResult {
  id: string;
  email: string;
  status: UserStatus;
  requiresEmailVerification: boolean;
  // Заполняются только когда подтверждение включено
  attemptId?: string;
  channel?: string;
  expiresAt?: Date;
}

export interface ConfirmResult {
  id: string;
  email: string;
  status: UserStatus;
  emailVerifiedAt: Date | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly settingsService: AuthSettingsService,
    private readonly verificationService: VerificationService,
    private readonly auditService: AuditService,
  ) {}

  async register(
    dto: RegisterDto,
    ctx: RequestContext,
  ): Promise<RegisterResult> {
    // 1. Читаем настройки: нужно ли подтверждение и чем подтверждать
    const settings = await this.settingsService.get();
    const needsVerification = settings.requireVerificationOnRegistration;

    // 2. Почта уже занята?
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      await this.audit(ctx, {
        event: AuthAuditEvent.RegistrationAttempt,
        success: false,
        email: dto.email,
        reason: 'email_taken',
      });
      throw new ConflictException('Этот адрес почты уже зарегистрирован');
    }

    // 3. Пароль превращаем в отпечаток
    const passwordHash = await this.passwordService.hash(dto.password);

    // 4. Создаём пользователя. Статус зависит от настройки:
    //    подтверждение нужно     -> аккаунт ждёт подтверждения
    //    подтверждение не нужно  -> аккаунт сразу рабочий
    let user: User;
    try {
      user = await this.usersService.create({
        email: dto.email,
        passwordHash,
        status: needsVerification
          ? UserStatus.PendingVerification
          : UserStatus.Active,
        emailVerifiedAt: null,
      });
    } catch (error) {
      // Страховка от гонки: два запроса с одной почтой в одну миллисекунду
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string })?.code === PG_UNIQUE_VIOLATION
      ) {
        await this.audit(ctx, {
          event: AuthAuditEvent.RegistrationAttempt,
          success: false,
          email: dto.email,
          reason: 'email_taken_race',
        });
        throw new ConflictException('Этот адрес почты уже зарегистрирован');
      }
      throw error;
    }

    await this.audit(ctx, {
      event: AuthAuditEvent.RegistrationAttempt,
      success: true,
      email: user.email,
      userId: user.id,
    });

    // 5а. Подтверждение выключено — на этом всё, можно входить
    if (!needsVerification) {
      return {
        id: user.id,
        email: user.email,
        status: user.status,
        requiresEmailVerification: false,
      };
    }

    // 5б. Подтверждение включено — выдаём код или ссылку и отправляем письмо
    const started = await this.verificationService.start(
      user,
      VerificationPurpose.Registration,
      settings.verificationChannel,
    );

    await this.audit(ctx, {
      event: AuthAuditEvent.VerificationSent,
      success: true,
      email: user.email,
      userId: user.id,
      reason: started.channel,
    });

    return {
      id: user.id,
      email: user.email,
      status: user.status,
      requiresEmailVerification: true,
      attemptId: started.attemptId,
      channel: started.channel,
      expiresAt: started.expiresAt,
    };
  }

  /** Подтверждение кодом из письма */
  async confirmOtp(
    dto: ConfirmOtpDto,
    ctx: RequestContext,
  ): Promise<ConfirmResult> {
    try {
      const userId = await this.verificationService.confirmOtp(
        dto.attemptId,
        dto.code,
      );
      return await this.activate(userId, ctx);
    } catch (error) {
      await this.audit(ctx, {
        event: AuthAuditEvent.VerificationConfirmed,
        success: false,
        reason: 'otp_invalid',
      });
      throw error;
    }
  }

  /** Подтверждение переходом по ссылке из письма */
  async confirmMagicLink(
    token: string,
    ctx: RequestContext,
  ): Promise<ConfirmResult> {
    try {
      const userId = await this.verificationService.confirmMagicLink(token);
      return await this.activate(userId, ctx);
    } catch (error) {
      await this.audit(ctx, {
        event: AuthAuditEvent.VerificationConfirmed,
        success: false,
        reason: 'link_invalid',
      });
      throw error;
    }
  }

  /** Отправить письмо заново */
  async resend(
    dto: ResendDto,
    ctx: RequestContext,
  ): Promise<{ attemptId: string; expiresAt: Date }> {
    const userId = await this.verificationService.getUserId(dto.attemptId);
    const user = await this.usersService.findByIdOrFail(userId);

    const started = await this.verificationService.resend(dto.attemptId, user);

    await this.audit(ctx, {
      event: AuthAuditEvent.VerificationSent,
      success: true,
      email: user.email,
      userId: user.id,
      reason: 'resend',
    });

    return { attemptId: started.attemptId, expiresAt: started.expiresAt };
  }

  /** Общая часть обоих подтверждений: делаем аккаунт рабочим */
  private async activate(
    userId: string,
    ctx: RequestContext,
  ): Promise<ConfirmResult> {
    const user = await this.usersService.markEmailVerified(userId);

    await this.audit(ctx, {
      event: AuthAuditEvent.VerificationConfirmed,
      success: true,
      email: user.email,
      userId: user.id,
    });

    this.logger.log(`Почта подтверждена: пользователь ${user.id}`);

    return {
      id: user.id,
      email: user.email,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
    };
  }

  private audit(
    ctx: RequestContext,
    data: Omit<AuditRecord, 'ip' | 'userAgent'>,
  ) {
    return this.auditService.record({ ...data, ...ctx });
  }
}
