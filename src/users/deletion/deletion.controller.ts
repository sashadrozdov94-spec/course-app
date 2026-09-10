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
@ApiTags('Удаление аккаунта')
@ApiResponse({ status: 429, description: 'Превышен лимит запросов' })
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
  @ApiOperation({
    summary: 'Запросить удаление',
    description:
      'Свой аккаунт — в ответ придёт требование подтверждения по почте: ' +
      'удаление необратимо. Чужой — с правом users@delete удаляется сразу. ' +
      'Строка удаляется физически, записи журналов остаются.',
  })
  @ApiCookieAuth('access_token')
  @ApiZodBody(deleteUserSchema, 'Необязательная причина для аудита')
  @ApiResponse({
    status: 200,
    description: 'Удалено либо требуется подтверждение',
  })
  @ApiResponse({ status: 400, description: 'Некорректный номер или тело' })
  @ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
  @ApiResponse({ status: 403, description: 'Нет права users@delete' })
  @ApiResponse({ status: 404, description: 'Пользователь не найден' })
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
  @ApiOperation({ summary: 'Подтвердить удаление кодом' })
  @ApiCookieAuth('access_token')
  @ApiZodBody(confirmDeletionSchema)
  @ApiResponse({ status: 200, description: 'Аккаунт удалён' })
  @ApiResponse({ status: 400, description: 'Неверный код или истёк срок' })
  @ApiResponse({ status: 403, description: 'Чужая попытка' })
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
  @ApiOperation({
    summary: 'Подтвердить удаление по ссылке',
    description: 'БЕЗ входа: пропуском служит одноразовый токен из письма.',
  })
  @ApiQuery({ name: 'token', required: true, description: 'Токен из письма' })
  @ApiResponse({ status: 200, description: 'Аккаунт удалён' })
  @ApiResponse({
    status: 400,
    description: 'Ссылка недействительна или использована',
  })
  @Get('deletion/confirm')
  @RateLimit({ limit: 10, windowSeconds: 60 })
  confirmByLink(@Query('token') token: string): Promise<DeletionDone> {
    return this.deletion.confirmByLink(token ?? '');
  }
}
