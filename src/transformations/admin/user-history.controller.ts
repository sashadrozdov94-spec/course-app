import {
  Controller,
  Get,
  Param,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { ApiZodQuery } from '../../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { User } from '../../users/entities/user.entity.js';
import {
  type UserIdParam,
  userIdParamSchema,
} from '../../users/shared/user-id.dto.js';
import { type ItemIdParam, itemIdParamSchema } from '../dto/item-id.dto.js';
import {
  type ListHistoryDto,
  listHistorySchema,
  type TransformationHistoryPage,
} from '../dto/list-history.dto.js';
import {
  HistoryDownloadService,
  toStreamable,
} from '../history-download.service.js';
import { HistoryReadService } from '../history-read.service.js';

/**
 * История трансформаций конкретного пользователя (п. 1.3.2 ТЗ).
 *
 * Адрес /admin/users/{userId}/..., как и список пользователей: раздел
 * администратора в проекте уже живёт под /admin/*, и по адресу сразу
 * видно, что окно не для всех.
 *
 * Право проверяется внутри сервиса, а не наклейкой @RequirePermission:
 * так отказ попадает в журнал вместе с тем, чью историю пытались открыть,
 * чего требует п. 1.5 ТЗ.
 *
 * Ограничитель здесь строже, чем на своей истории: п. 1.4 ТЗ просит об
 * этом отдельно, и не зря — своя история у каждого одна, а чужих у
 * администратора столько же, сколько пользователей.
 */
@ApiTags('Администратор: история трансформаций')
@ApiCookieAuth('access_token')
@Controller('admin/users/:userId/transformations/history')
@UseGuards(RateLimitGuard, JwtAuthGuard)
export class UserHistoryController {
  constructor(
    private readonly history: HistoryReadService,
    private readonly downloads: HistoryDownloadService,
  ) {}

  @ApiOperation({
    summary: 'История трансформаций пользователя',
    description:
      'Требует право transformations@history_admin. Параметры и формат ' +
      'ответа те же, что у своей истории. Свою историю можно смотреть и ' +
      'без права.',
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiZodQuery(listHistorySchema)
  @ApiResponse({ status: 200, description: 'items + nextCursor' })
  @ApiResponse({
    status: 400,
    description: 'Некорректные параметры, курсор или номер пользователя',
  })
  @ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
  @ApiResponse({
    status: 403,
    description: 'Нет права transformations@history_admin',
  })
  @ApiResponse({ status: 404, description: 'Пользователь не найден' })
  @ApiResponse({ status: 429, description: 'Превышен лимит запросов' })
  @Get()
  @RateLimit({ limit: 30, windowSeconds: 60 })
  list(
    @Param(new ZodValidationPipe(userIdParamSchema)) params: UserIdParam,
    @Query(new ZodValidationPipe(listHistorySchema)) query: ListHistoryDto,
    @CurrentUser() me: User,
  ): Promise<TransformationHistoryPage> {
    return this.history.listFor(me, params.userId, query);
  }

  /**
   * GET /admin/users/{userId}/transformations/history/{itemId}/download
   *
   * Запись ищется сразу вместе с владельцем: существующая запись, но
   * чужая — для этого окна то же самое, что «нет записи». Отвечать иначе
   * значило бы рассказывать, кому какая запись принадлежит.
   */
  @ApiOperation({
    summary: 'Скачать сохранённый результат пользователя',
    description:
      'Требует право transformations@history_admin. Свои файлы можно ' +
      'скачивать и без права.',
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Файл результата' })
  @ApiResponse({ status: 400, description: 'Некорректные номера' })
  @ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
  @ApiResponse({
    status: 403,
    description: 'Нет права transformations@history_admin',
  })
  @ApiResponse({
    status: 404,
    description:
      'Нет пользователя или записи, файл не сохраняли или он недоступен',
  })
  @ApiResponse({ status: 410, description: 'Срок хранения файла истёк' })
  @ApiResponse({ status: 429, description: 'Превышен лимит запросов' })
  @Get(':itemId/download')
  @RateLimit({ limit: 30, windowSeconds: 60 })
  async download(
    @Param(new ZodValidationPipe(userIdParamSchema)) owner: UserIdParam,
    @Param(new ZodValidationPipe(itemIdParamSchema)) item: ItemIdParam,
    @CurrentUser() me: User,
  ): Promise<StreamableFile> {
    return toStreamable(
      await this.downloads.downloadFor(me, owner.userId, item.itemId),
    );
  }
}
