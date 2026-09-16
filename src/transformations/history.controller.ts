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
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { ApiZodQuery } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { User } from '../users/entities/user.entity.js';
import {
  type ListHistoryDto,
  listHistorySchema,
  type TransformationHistoryPage,
} from './dto/list-history.dto.js';
import { itemIdParamSchema, type ItemIdParam } from './dto/item-id.dto.js';
import {
  HistoryDownloadService,
  toStreamable,
} from './history-download.service.js';
import { HistoryReadService } from './history-read.service.js';

/**
 * Своя история трансформаций (п. 1.3.1 ТЗ).
 *
 * Прав не требует и номера пользователя в адресе не принимает: чью
 * историю отдавать, решает токен, а не строка запроса. Это не мелочь —
 * `?userId=` в таком окне рано или поздно забывают проверить, и чужая
 * история утекает.
 */
@ApiTags('История трансформаций')
@ApiCookieAuth('access_token')
@Controller('api/transformations/history')
@UseGuards(RateLimitGuard, JwtAuthGuard)
export class HistoryController {
  constructor(
    private readonly history: HistoryReadService,
    private readonly downloads: HistoryDownloadService,
  ) {}

  /**
   * GET /api/transformations/history?limit=&cursor=&type=&status=…
   */
  @ApiOperation({
    summary: 'Своя история трансформаций',
    description:
      'Записи обоих модулей — и файлов, и изображений — в одном списке, ' +
      'новые сверху. Пагинация курсорная: nextCursor из ответа передайте ' +
      'в cursor следующего запроса.',
  })
  @ApiZodQuery(listHistorySchema)
  @ApiResponse({ status: 200, description: 'items + nextCursor' })
  @ApiResponse({
    status: 400,
    description: 'Некорректные параметры или курсор',
  })
  @ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
  @ApiResponse({ status: 429, description: 'Превышен лимит запросов' })
  @Get()
  @RateLimit({ limit: 60, windowSeconds: 60 })
  list(
    @Query(new ZodValidationPipe(listHistorySchema)) query: ListHistoryDto,
    @CurrentUser() me: User,
  ): Promise<TransformationHistoryPage> {
    return this.history.listOwn(me, query);
  }

  /**
   * GET /api/transformations/history/{itemId}/download
   *
   * Скачивание идёт по номеру записи, а не по ссылке на файл: ключ в
   * хранилище наружу не отдаётся никогда, а право проверяется на каждый
   * запрос — см. history-download.service.ts.
   */
  @ApiOperation({
    summary: 'Скачать сохранённый результат',
    description:
      'Доступно, если трансформацию выполняли с save=true и срок ' +
      'хранения не истёк. Срок совпадает с периодом очистки истории.',
  })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Файл результата' })
  @ApiResponse({ status: 400, description: 'Некорректный номер записи' })
  @ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
  @ApiResponse({ status: 403, description: 'Запись принадлежит не вам' })
  @ApiResponse({
    status: 404,
    description: 'Записи нет, файл не сохраняли или он недоступен',
  })
  @ApiResponse({ status: 410, description: 'Срок хранения файла истёк' })
  @ApiResponse({ status: 429, description: 'Превышен лимит запросов' })
  @Get(':itemId/download')
  @RateLimit({ limit: 60, windowSeconds: 60 })
  async download(
    @Param(new ZodValidationPipe(itemIdParamSchema)) params: ItemIdParam,
    @CurrentUser() me: User,
  ): Promise<StreamableFile> {
    return toStreamable(await this.downloads.downloadOwn(me, params.itemId));
  }
}
