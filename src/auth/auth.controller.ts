import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiZodBody } from '../common/openapi/zod-openapi.js';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Env } from '../config/env.schema.js';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { User } from '../users/entities/user.entity.js';
import type { RequestContext } from './audit.service.js';
import { AuthService, type ConfirmResult } from './auth.service.js';
import {
  clearAuthCookies,
  type CookieSettings,
  REFRESH_COOKIE,
  setAuthCookies,
} from './cookies.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import {
  type ConfirmOtpDto,
  confirmOtpSchema,
  type ResendDto,
  resendSchema,
} from './dto/confirm.dto.js';
import { type LoginDto, loginSchema } from './dto/login.dto.js';
import { type RegisterDto, registerSchema } from './dto/register.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';

// Все адреса этой коробки начинаются с /auth
@ApiTags('Аутентификация')
@ApiResponse({ status: 429, description: 'Превышен лимит запросов' })
@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ───────────────────────── регистрация ─────────────────────────

  // POST /auth/register
  @ApiOperation({
    summary: 'Регистрация',
    description:
      'Если подтверждение при регистрации включено настройкой, в ответ ' +
      'придёт номер попытки, а аккаунт останется неподтверждённым.',
  })
  @ApiZodBody(registerSchema)
  @ApiResponse({ status: 201, description: 'Аккаунт создан' })
  @ApiResponse({
    status: 400,
    description: 'Некорректная почта или слабый пароль',
  })
  @ApiResponse({ status: 409, description: 'Почта уже занята' })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ limit: 5, windowSeconds: 60 })
  register(
    @Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto,
    @Req() request: Request,
  ) {
    return this.authService.register(dto, this.context(request));
  }

  // ─────────────────────────── вход ───────────────────────────

  /**
   * POST /auth/login
   *
   * @Res({ passthrough: true }) — нам нужен объект ответа, чтобы поставить
   * cookies, но тело ответа пусть формирует Nest, как обычно.
   * Без passthrough пришлось бы вручную вызывать response.json().
   */
  @ApiOperation({
    summary: 'Вход',
    description:
      'Токены кладутся в httpOnly cookies. Если включено подтверждение ' +
      'входа, вместо токенов придёт номер попытки.',
  })
  @ApiZodBody(loginSchema)
  @ApiResponse({
    status: 200,
    description: 'Вход выполнен либо требуется подтверждение',
  })
  @ApiResponse({ status: 401, description: 'Неверная почта или пароль' })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Лимит строгий: 10 попыток в минуту с одного адреса. Это защита от
  // перебора паролей, требование 1.6 из ТЗ.
  @RateLimit({ limit: 10, windowSeconds: 60 })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.login(dto, this.context(request));

    // Подтверждение входа включено — токенов ещё нет, отдаём номер попытки
    if (result.requiresEmailVerification) {
      return {
        requiresEmailVerification: true,
        attemptId: result.attemptId,
        channel: result.channel,
        expiresAt: result.expiresAt,
      };
    }

    // Токены кладём в cookies, а НЕ в тело ответа: так до них не доберётся
    // посторонний скрипт на странице
    setAuthCookies(response, result.tokens!, this.cookieSettings());

    return { requiresEmailVerification: false, user: result.user };
  }

  /** POST /auth/refresh — обменять refresh-токен на новую пару. */
  @ApiOperation({
    summary: 'Обновить пару токенов',
    description: 'refresh-токен берётся из cookie. Выдаётся новая пара.',
  })
  @ApiCookieAuth('refresh_token')
  @ApiResponse({ status: 200, description: 'Выдана новая пара' })
  @ApiResponse({
    status: 401,
    description: 'Токен отсутствует, истёк или аккаунт неактивен',
  })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 30, windowSeconds: 60 })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = request.cookies?.[REFRESH_COOKIE] as string | undefined;
    const tokens = await this.authService.refresh(token);

    setAuthCookies(response, tokens, this.cookieSettings());

    return { refreshed: true };
  }

  /**
   * POST /auth/logout — выход.
   *
   * По ТЗ refresh-токены на сервере не хранятся, поэтому «отозвать» выданный
   * токен нельзя. Выход = очистка cookies у этого клиента.
   */
  @ApiOperation({
    summary: 'Выход',
    description:
      'Стирает cookies. Отозвать уже выданный refresh-токен нельзя: ' +
      'на сервере они не хранятся.',
  })
  @ApiResponse({ status: 200, description: 'Cookies стёрты' })
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) response: Response) {
    clearAuthCookies(response, this.cookieSettings());
    return { loggedOut: true };
  }

  /** GET /auth/me — кто я. Первое закрытое окно: работает только с токеном. */
  @ApiOperation({ summary: 'Кто я' })
  @ApiCookieAuth('access_token')
  @ApiResponse({ status: 200, description: 'Свой профиль' })
  @ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: User) {
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
    };
  }

  // ──────────────────── подтверждение по почте ────────────────────

  /** POST /auth/confirm-otp — код из письма (и для регистрации, и для входа). */
  @ApiOperation({
    summary: 'Подтвердить код из письма',
    description:
      'Только для регистрации и входа. Коды смены почты и удаления ' +
      'аккаунта здесь не принимаются.',
  })
  @ApiZodBody(confirmOtpSchema)
  @ApiResponse({ status: 200, description: 'Подтверждено' })
  @ApiResponse({
    status: 400,
    description: 'Неверный код, истёк срок или код не для этого сценария',
  })
  @Post('confirm-otp')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  async confirmOtp(
    @Body(new ZodValidationPipe(confirmOtpSchema)) dto: ConfirmOtpDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.confirmOtp(
      dto,
      this.context(request),
    );
    return this.finishConfirmation(result, response);
  }

  /** GET /auth/confirm?token=... — переход по ссылке из письма. */
  @ApiOperation({
    summary: 'Подтвердить по ссылке из письма',
    description: 'Только для регистрации и входа.',
  })
  @ApiQuery({ name: 'token', required: true, description: 'Токен из письма' })
  @ApiResponse({ status: 200, description: 'Подтверждено' })
  @ApiResponse({
    status: 400,
    description: 'Ссылка недействительна или использована',
  })
  @Get('confirm')
  @RateLimit({ limit: 10, windowSeconds: 60 })
  async confirmLink(
    @Query('token') token: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.confirmMagicLink(
      token ?? '',
      this.context(request),
    );
    return this.finishConfirmation(result, response);
  }

  /** POST /auth/resend — отправить письмо заново. */
  @ApiOperation({
    summary: 'Отправить письмо заново',
    description: 'Не чаще, чем раз в OTP_RESEND_COOLDOWN_SECONDS.',
  })
  @ApiZodBody(resendSchema)
  @ApiResponse({ status: 200, description: 'Письмо отправлено' })
  @ApiResponse({
    status: 400,
    description: 'Слишком рано или попытка не найдена',
  })
  @Post('resend')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 3, windowSeconds: 60 })
  resend(
    @Body(new ZodValidationPipe(resendSchema)) dto: ResendDto,
    @Req() request: Request,
  ) {
    return this.authService.resend(dto, this.context(request));
  }

  // ─────────────────────────── помощники ───────────────────────────

  /** Подтверждали вход — ставим cookies. Подтверждали регистрацию — нет. */
  private finishConfirmation(result: ConfirmResult, response: Response) {
    if (result.tokens) {
      setAuthCookies(response, result.tokens, this.cookieSettings());
    }

    return { purpose: result.purpose, user: result.user };
  }

  /** Достаём из запроса адрес клиента и название браузера — для журнала. */
  private context(request: Request): RequestContext {
    return {
      ip: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    };
  }

  /** Настройки cookies из .env. */
  private cookieSettings(): CookieSettings {
    return {
      secure: this.config.get('COOKIE_SECURE', { infer: true }),
      sameSite: this.config.get('COOKIE_SAMESITE', { infer: true }),
    };
  }
}
