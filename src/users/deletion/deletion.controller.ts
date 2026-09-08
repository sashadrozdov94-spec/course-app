import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  DeletionService,
  type DeletionDone,
  type DeletionRequiresConfirmation,
} from './deletion.service.js';
import {
  type ConfirmDeletionDto,
  confirmDeletionSchema,
  type DeleteUserDto,
  deleteUserSchema,
} from './dto/delete-user.dto.js';
import { userIdParamSchema } from '../shared/user-id.dto.js';
import type { User } from '../entities/user.entity.js';

/**
 * Удаление пользователя (п. 1 ТЗ).
 *
 * Отдельный контроллер от UsersController, потому что здесь смешаны окна
 * закрытые и открытое: подтверждение по ссылке из письма должно работать
 * там, где сессии нет. Поэтому JwtAuthGuard стоит на методах, а не на
 * классе — на классе только ограничитель частоты, он нужен всем.
 */
@Controller('users')
@UseGuards(RateLimitGuard)
export class DeletionController {
  constructor(private readonly deletion: DeletionService) {}

  /**
   * DELETE /users/:userId — запросить удаление.
   *
   * Свой аккаунт — в ответ придёт требование подтверждения: удаление
   * необратимо, и ТЗ требует подтверждать его по почте.
   * Чужой — с правом users@delete удаляется сразу.
   */
  @Delete(':userId')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  @UseGuards(JwtAuthGuard)
  request(
    @Param(new ZodValidationPipe(userIdParamSchema))
    params: { userId: string },
    @Body(new ZodValidationPipe(deleteUserSchema)) body: DeleteUserDto,
    @CurrentUser() me: User,
  ): Promise<DeletionRequiresConfirmation | DeletionDone> {
    return this.deletion.request(me, params.userId, body.reason);
  }

  /** POST /users/:userId/deletion/confirm — подтверждение кодом. */
  @Post(':userId/deletion/confirm')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  @UseGuards(JwtAuthGuard)
  confirmByCode(
    @Param(new ZodValidationPipe(userIdParamSchema))
    params: { userId: string },
    @Body(new ZodValidationPipe(confirmDeletionSchema)) dto: ConfirmDeletionDto,
    @CurrentUser() me: User,
  ): Promise<DeletionDone> {
    return this.deletion.confirmByCode(me, params.userId, dto);
  }

  /**
   * GET /users/deletion/confirm?token=... — подтверждение по ссылке.
   *
   * Без входа, как и подтверждение регистрации: письмо открывают в том
   * клиенте, где читают почту, а не там, где залогинены. Пропуском служит
   * одноразовый токен со сроком, привязанный в базе к конкретному человеку.
   *
   * Два сегмента после /users, поэтому с GET /users/:userId не спорит.
   */
  @Get('deletion/confirm')
  @RateLimit({ limit: 10, windowSeconds: 60 })
  confirmByLink(@Query('token') token: string): Promise<DeletionDone> {
    return this.deletion.confirmByLink(token ?? '');
  }
}
