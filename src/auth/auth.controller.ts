import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { RequestContext } from './audit.service.js';
import { AuthService } from './auth.service.js';
import {
  type ConfirmOtpDto,
  confirmOtpSchema,
  type ResendDto,
  resendSchema,
} from './dto/confirm.dto.js';
import { type RegisterDto, registerSchema } from './dto/register.dto.js';

// Все адреса этой коробки начинаются с /auth
@Controller('auth')
// Охранник частоты запросов работает на всех методах этого контроллера,
// но срабатывает только там, где есть наклейка @RateLimit
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // POST /auth/register — регистрация
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ limit: 5, windowSeconds: 60 })
  register(
    @Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto,
    @Req() request: Request,
  ) {
    return this.authService.register(dto, this.context(request));
  }

  // POST /auth/confirm-otp — подтверждение кодом из письма
  @Post('confirm-otp')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  confirmOtp(
    @Body(new ZodValidationPipe(confirmOtpSchema)) dto: ConfirmOtpDto,
    @Req() request: Request,
  ) {
    return this.authService.confirmOtp(dto, this.context(request));
  }

  // GET /auth/confirm?token=... — подтверждение по ссылке из письма.
  // GET, потому что по ссылке из письма браузер делает именно GET.
  @Get('confirm')
  @RateLimit({ limit: 10, windowSeconds: 60 })
  confirmLink(@Query('token') token: string, @Req() request: Request) {
    return this.authService.confirmMagicLink(
      token ?? '',
      this.context(request),
    );
  }

  // POST /auth/resend — отправить письмо заново
  @Post('resend')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 3, windowSeconds: 60 })
  resend(
    @Body(new ZodValidationPipe(resendSchema)) dto: ResendDto,
    @Req() request: Request,
  ) {
    return this.authService.resend(dto, this.context(request));
  }

  /** Достаём из запроса адрес клиента и название браузера — для журнала. */
  private context(request: Request): RequestContext {
    return {
      ip: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    };
  }
}
