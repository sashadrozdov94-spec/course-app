import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiZodBody } from '../../common/openapi/zod-openapi.js';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  type ConfirmEmailChangeDto,
  confirmEmailChangeSchema,
  type EmailChangeDto,
  emailChangeSchema,
} from './dto/email-change.dto.js';
import { userIdParamSchema } from '../shared/user-id.dto.js';
import type { User } from '../entities/user.entity.js';
import {
  type EmailChangeConfirmed,
  EmailChangeService,
  type EmailChangeStarted,
} from './email-change.service.js';

/**
 * Смена почты целиком: запрос, подтверждение кодом, подтверждение ссылкой
 * (п. 1.3.2 и 1.3.3 ТЗ).
 *
 * Отдельный контроллер, а не методы в UsersController, потому что здесь
 * смешаны окна закрытые и открытое: ссылку из письма открывают там, где
 * читают почту, а не там, где залогинены. Поэтому JwtAuthGuard стоит на
 * методах, а на классе — только ограничитель частоты, он нужен всем.
 *
 * Устроено так же, как DeletionController: у сценария с
 * подтверждением по почте свой контроллер и свои лимиты.
 */
@ApiTags('Смена почты')
@ApiResponse({ status: 429, description: 'Превышен лимит запросов' })
@Controller('users')
@UseGuards(RateLimitGuard)
export class EmailChangeController {
  constructor(private readonly emailChange: EmailChangeService) {}

  /**
   * POST /users/:userId/email-change — запросить смену почты.
   *
   * Только себе. Код или ссылка уходит на НОВЫЙ адрес — это и есть
   * доказательство, что человек им владеет. Администратор сюда не ходит:
   * он меняет почту напрямую через PATCH, ему подтверждать нечего.
   *
   * Лимит по адресу клиента — сеть на всех; персональный, гораздо более
   * строгий (5 за час), стоит в ProfileWriteLimiter: каждый такой запрос
   * шлёт письмо на указанный адрес, то есть постороннему человеку.
   */
  @ApiOperation({
    summary: 'Запросить смену почты',
    description:
      'Только себе. Код или ссылка уходит на НОВЫЙ адрес — это и есть ' +
      'доказательство владения им. Чем подтверждать, решает сервер ' +
      'настройкой verificationChannel.',
  })
  @ApiCookieAuth('access_token')
  @ApiZodBody(emailChangeSchema)
  @ApiResponse({
    status: 200,
    description: 'Требуется подтверждение: challengeId, channel, expiresAt',
  })
  @ApiResponse({ status: 400, description: 'Некорректный адрес' })
  @ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
  @ApiResponse({ status: 403, description: 'Попытка сменить чужую почту' })
  @ApiResponse({ status: 409, description: 'Адрес уже занят' })
  @Post(':userId/email-change')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  @UseGuards(JwtAuthGuard)
  request(
    @Param(new ZodValidationPipe(userIdParamSchema))
    params: { userId: string },
    @Body(new ZodValidationPipe(emailChangeSchema)) dto: EmailChangeDto,
    @CurrentUser() me: User,
  ): Promise<EmailChangeStarted> {
    return this.emailChange.request(me, params.userId, dto.newEmail);
  }

  /**
   * POST /users/:userId/email-change/confirm — подтвердить кодом (вариант A).
   *
   * Срок жизни кода, число попыток и его гашение — на стороне
   * VerificationService, значения берутся из OTP_* в .env.
   */
  @ApiOperation({
    summary: 'Подтвердить смену кодом',
    description: 'Вариант A. Срок и число попыток — из OTP_* в .env.',
  })
  @ApiCookieAuth('access_token')
  @ApiZodBody(confirmEmailChangeSchema)
  @ApiResponse({ status: 200, description: 'Почта изменена' })
  @ApiResponse({
    status: 400,
    description: 'Неверный код, истёк срок или кончились попытки',
  })
  @ApiResponse({ status: 403, description: 'Чужая попытка' })
  @ApiResponse({ status: 404, description: 'Попытка не найдена' })
  @ApiResponse({ status: 409, description: 'Адрес успели занять' })
  @Post(':userId/email-change/confirm')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  @UseGuards(JwtAuthGuard)
  confirmByCode(
    @Param(new ZodValidationPipe(userIdParamSchema))
    params: { userId: string },
    @Body(new ZodValidationPipe(confirmEmailChangeSchema))
    dto: ConfirmEmailChangeDto,
    @CurrentUser() me: User,
  ): Promise<EmailChangeConfirmed> {
    return this.emailChange.confirmByCode(me, params.userId, dto);
  }

  /**
   * GET /users/email-change/confirm?token=... — подтвердить ссылкой (B).
   *
   * Без входа, как и подтверждение регистрации в GET /auth/confirm.
   * Пропуском служит одноразовый токен со сроком, привязанный в базе к
   * конкретному человеку.
   *
   * Два сегмента после /users, поэтому с GET /users/:userId не спорит.
   */
  @ApiOperation({
    summary: 'Подтвердить смену по ссылке',
    description:
      'Вариант B. БЕЗ входа: письмо открывают там, где читают почту, а не ' +
      'там, где залогинены. Пропуск — одноразовый токен со сроком.',
  })
  @ApiQuery({ name: 'token', required: true, description: 'Токен из письма' })
  @ApiResponse({ status: 200, description: 'Почта изменена' })
  @ApiResponse({
    status: 400,
    description: 'Ссылка недействительна, использована или истекла',
  })
  @Get('email-change/confirm')
  @RateLimit({ limit: 10, windowSeconds: 60 })
  confirmByLink(@Query('token') token: string): Promise<EmailChangeConfirmed> {
    return this.emailChange.confirmByLink(token ?? '');
  }
}
