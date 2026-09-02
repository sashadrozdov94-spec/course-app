import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
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
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import { AuthAuditEvent } from './entities/auth-audit-log.entity.js';
import { VerificationPurpose } from './entities/email-verification.entity.js';
import { PasswordService } from './password.service.js';
import { type TokenPair, TokenService } from './token.service.js';
import { VerificationService } from './verification.service.js';

// Код ошибки PostgreSQL «нарушено требование уникальности»
const PG_UNIQUE_VIOLATION = '23505';

// Отпечаток несуществующего пароля. Нужен, чтобы сравнение занимало
// одинаковое время независимо от того, есть такой пользователь или нет.
const DUMMY_HASH = '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';

export interface RegisterResult {
  id: string;
  email: string;
  status: UserStatus;
  requiresEmailVerification: boolean;
  attemptId?: string;
  channel?: string;
  expiresAt?: Date;
}

/** Результат входа: либо токены, либо «нужно подтверждение». */
export interface LoginResult {
  requiresEmailVerification: boolean;
  tokens?: TokenPair;
  user?: { id: string; email: string };
  attemptId?: string;
  channel?: string;
  expiresAt?: Date;
}

/** Результат подтверждения кода или ссылки. */
export interface ConfirmResult {
  purpose: VerificationPurpose;
  user: {
    id: string;
    email: string;
    status: UserStatus;
    emailVerifiedAt: Date | null;
  };
  // Заполняются, только если подтверждали вход
  tokens?: TokenPair;
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
    private readonly tokenService: TokenService,
  ) {}

  // ───────────────────────── РЕГИСТРАЦИЯ ─────────────────────────

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

  // ─────────────────────────── ВХОД ───────────────────────────

  async login(dto: LoginDto, ctx: RequestContext): Promise<LoginResult> {
    // Отпечаток пароля скрыт от обычных выборок, поэтому просим его явно
    const user = await this.usersService.findByEmailWithPassword(dto.email);

    // Сравниваем пароль ВСЕГДА, даже если пользователя нет.
    // Иначе по времени ответа можно было бы понять, какие адреса
    // зарегистрированы: «нет пользователя» отвечало бы заметно быстрее.
    const passwordMatches = await this.passwordService.verify(
      dto.password,
      user?.passwordHash ?? DUMMY_HASH,
    );

    if (!user || !passwordMatches) {
      await this.audit(ctx, {
        event: AuthAuditEvent.LoginAttempt,
        success: false,
        email: dto.email,
        reason: user ? 'wrong_password' : 'user_not_found',
      });
      // Один и тот же текст в обоих случаях: не подсказываем, что именно
      // не сошлось — почта или пароль.
      throw new UnauthorizedException('Неверная почта или пароль');
    }

    if (user.status === UserStatus.Blocked) {
      await this.audit(ctx, {
        event: AuthAuditEvent.LoginAttempt,
        success: false,
        email: user.email,
        userId: user.id,
        reason: 'blocked',
      });
      throw new ForbiddenException('Аккаунт заблокирован');
    }

    // Почта не подтверждена — входить нельзя, надо сначала закончить регистрацию
    if (user.status === UserStatus.PendingVerification) {
      await this.audit(ctx, {
        event: AuthAuditEvent.LoginAttempt,
        success: false,
        email: user.email,
        userId: user.id,
        reason: 'email_not_verified',
      });
      throw new ForbiddenException('Сначала подтвердите адрес почты');
    }

    const settings = await this.settingsService.get();

    // Вариант Б из ТЗ: подтверждение входа включено — токены НЕ выдаём
    if (settings.requireVerificationOnLogin) {
      const started = await this.verificationService.start(
        user,
        VerificationPurpose.Login,
        settings.verificationChannel,
      );

      await this.audit(ctx, {
        event: AuthAuditEvent.VerificationSent,
        success: true,
        email: user.email,
        userId: user.id,
        reason: `login_${started.channel}`,
      });

      return {
        requiresEmailVerification: true,
        attemptId: started.attemptId,
        channel: started.channel,
        expiresAt: started.expiresAt,
      };
    }

    // Вариант А из ТЗ: подтверждение выключено — сразу выдаём токены
    const tokens = await this.issueTokens(user);

    await this.audit(ctx, {
      event: AuthAuditEvent.LoginAttempt,
      success: true,
      email: user.email,
      userId: user.id,
    });

    return {
      requiresEmailVerification: false,
      tokens,
      user: { id: user.id, email: user.email },
    };
  }

  /**
   * Обновление токенов.
   *
   * По ТЗ refresh на сервере не хранится, поэтому проверяем только подпись
   * и срок. Ротация: выдаём новую пару, старая просто доживает свой срок.
   */
  async refresh(refreshToken: string | undefined): Promise<TokenPair> {
    if (!refreshToken) {
      throw new UnauthorizedException('Требуется вход');
    }

    const payload = this.tokenService.verifyRefresh(refreshToken);
    const user = await this.usersService.findById(payload.sub);

    if (!user || user.status !== UserStatus.Active) {
      throw new UnauthorizedException('Требуется вход');
    }

    return this.issueTokens(user);
  }

  // ──────────────────── ПОДТВЕРЖДЕНИЕ ПО ПОЧТЕ ────────────────────

  /** Подтверждение кодом из письма. Работает и для регистрации, и для входа. */
  async confirmOtp(
    dto: ConfirmOtpDto,
    ctx: RequestContext,
  ): Promise<ConfirmResult> {
    try {
      const confirmed = await this.verificationService.confirmOtp(
        dto.attemptId,
        dto.code,
      );
      return await this.finishConfirmation(confirmed, ctx);
    } catch (error) {
      await this.audit(ctx, {
        event: AuthAuditEvent.VerificationConfirmed,
        success: false,
        reason: 'otp_invalid',
      });
      throw error;
    }
  }

  /** Подтверждение переходом по ссылке из письма. */
  async confirmMagicLink(
    token: string,
    ctx: RequestContext,
  ): Promise<ConfirmResult> {
    try {
      const confirmed = await this.verificationService.confirmMagicLink(token);
      return await this.finishConfirmation(confirmed, ctx);
    } catch (error) {
      await this.audit(ctx, {
        event: AuthAuditEvent.VerificationConfirmed,
        success: false,
        reason: 'link_invalid',
      });
      throw error;
    }
  }

  /** Отправить письмо заново. */
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

  // ─────────────────────── общие помощники ───────────────────────

  /**
   * Что делать после успешной проверки кода — зависит от того, зачем он выдавался:
   *   регистрация -> активируем аккаунт, токены не выдаём;
   *   вход        -> аккаунт не трогаем, выдаём токены.
   */
  private async finishConfirmation(
    confirmed: { userId: string; purpose: VerificationPurpose },
    ctx: RequestContext,
  ): Promise<ConfirmResult> {
    const isLogin = confirmed.purpose === VerificationPurpose.Login;

    const user = isLogin
      ? await this.usersService.findByIdOrFail(confirmed.userId)
      : await this.usersService.markEmailVerified(confirmed.userId);

    await this.audit(ctx, {
      event: isLogin
        ? AuthAuditEvent.LoginAttempt
        : AuthAuditEvent.VerificationConfirmed,
      success: true,
      email: user.email,
      userId: user.id,
      reason: isLogin ? 'login_confirmed' : null,
    });

    this.logger.log(
      isLogin
        ? `Вход подтверждён: пользователь ${user.id}`
        : `Почта подтверждена: пользователь ${user.id}`,
    );

    return {
      purpose: confirmed.purpose,
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        emailVerifiedAt: user.emailVerifiedAt,
      },
      tokens: isLogin ? await this.issueTokens(user) : undefined,
    };
  }

  private issueTokens(user: User): Promise<TokenPair> {
    return this.tokenService.issuePair({ sub: user.id, email: user.email });
  }

  private audit(
    ctx: RequestContext,
    data: Omit<AuditRecord, 'ip' | 'userAgent'>,
  ) {
    return this.auditService.record({ ...data, ...ctx });
  }
}
