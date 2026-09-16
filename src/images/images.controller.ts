import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { User } from '../users/entities/user.entity.js';
import {
  type ConvertImageDto,
  convertImageSchema,
} from './dto/convert-image.dto.js';
import { ImageFormat } from './image-format.js';
import {
  ImagesService,
  type SupportedDirection,
  type UploadedImage,
} from './images.service.js';

/**
 * Верхняя граница размера для multer.
 *
 * Отдельный лимит на каждый исходный формат проверяется позже, в сервисе:
 * multer работает до того, как формат вообще определён, и знать про
 * форматы не может. Здесь стоит потолок из самого большого лимита плюс
 * запас — он отсекает совсем безумные загрузки, не читая их в память
 * целиком.
 */
const HARD_LIMIT_BYTES = 32 * 1024 * 1024;

@ApiTags('Трансформация изображений')
@ApiCookieAuth('access_token')
@ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
@ApiResponse({ status: 429, description: 'Превышен лимит запросов' })
@Controller('api/images/convert')
@UseGuards(RateLimitGuard, JwtAuthGuard)
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  /**
   * GET /api/images/convert/formats — какие направления поддерживаются.
   *
   * Список собирается из зарегистрированных направлений, а не задан
   * константой: появится новый формат — он появится и здесь сам.
   */
  @ApiOperation({
    summary: 'Поддерживаемые направления конвертации',
    description:
      'Собирается из зарегистрированных направлений. Обратного ' +
      'направления (растр → svg) в списке нет и не будет: векторизация ' +
      'не поддерживается.',
  })
  @ApiResponse({
    status: 200,
    description: 'Массив { source, target[] }',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string', example: 'svg' },
          target: {
            type: 'array',
            items: { type: 'string' },
            example: ['png', 'jpeg'],
          },
        },
      },
    },
  })
  @Get('formats')
  @RateLimit({ limit: 60, windowSeconds: 60 })
  formats(): SupportedDirection[] {
    return this.images.supportedFormats();
  }

  /**
   * POST /api/images/convert — сконвертировать изображение.
   *
   * Возвращаем StreamableFile, а не Buffer: Buffer из обработчика Nest
   * прогоняется через обычный сериализатор ответа, и клиент получает
   * {"type":"Buffer","data":[137,80,...]} вместо файла. StreamableFile
   * отдаётся телом как есть и сам проставляет Content-Type и
   * Content-Disposition — это и есть «потоковый файл» из ТЗ.
   */
  @ApiOperation({
    summary: 'Конвертировать изображение',
    description:
      'Исходный формат определяется по содержимому. Лимит размера свой ' +
      'для каждого формата и задаётся в конфигурации. Поддерживаются ' +
      'png → jpeg, jpeg → png, svg → png и svg → jpeg.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'targetFormat'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Исходное изображение: PNG, JPEG или SVG',
        },
        targetFormat: {
          type: 'string',
          enum: Object.values(ImageFormat),
        },
        options: {
          type: 'string',
          description:
            'Объект JSON строкой — вложенных объектов в multipart нет. ' +
            'quality (1–100) — качество JPEG; width и height — размер ' +
            'растра при растеризации SVG; background — цвет холста ' +
            '(#rgb, #rgba, #rrggbb, #rrggbbaa или transparent), по ' +
            'умолчанию #ffffff. Параметр, которого направление не ' +
            'понимает (например quality для PNG), — ошибка 400.',
          example: '{"width":512,"background":"#ffffff"}',
        },
        save: {
          type: 'string',
          enum: ['true', 'false'],
          description:
            'Сохранить результат в хранилище, чтобы скачать его позже из ' +
            'истории. По умолчанию false. Файл живёт столько же, сколько ' +
            'запись истории.',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Изображение в целевом формате' })
  @ApiResponse({
    status: 400,
    description:
      'Невалидное изображение, неподдерживаемое направление, ' +
      'некорректные параметры или превышение максимальных размеров',
  })
  @ApiResponse({
    status: 413,
    description: 'Превышен лимит размера для исходного формата',
  })
  @ApiResponse({ status: 415, description: 'Неподдерживаемый формат файла' })
  @ApiResponse({
    status: 500,
    description: 'Не удалось сохранить результат в хранилище (при save=true)',
  })
  @Post()
  @HttpCode(200)
  @RateLimit({ limit: 20, windowSeconds: 60 })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: HARD_LIMIT_BYTES, files: 1 },
    }),
  )
  async convert(
    @UploadedFile() file: UploadedImage | undefined,
    @Body(new ZodValidationPipe(convertImageSchema)) dto: ConvertImageDto,
    @CurrentUser() me: User,
  ): Promise<StreamableFile> {
    if (!file) {
      throw new BadRequestException('Файл обязателен');
    }

    const result = await this.images.convert(
      me.id,
      file,
      dto.targetFormat,
      dto.options,
      dto.save,
    );

    return new StreamableFile(result.body, {
      type: result.mime,
      disposition: `attachment; filename="${result.filename}"`,
      length: result.body.byteLength,
    });
  }
}
