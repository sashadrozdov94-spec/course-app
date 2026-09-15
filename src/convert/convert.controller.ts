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
import { ConvertService, type SupportedDirection } from './convert.service.js';
import { type ConvertDto, convertSchema } from './dto/convert.dto.js';

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

/**
 * Что кладёт multer в @UploadedFile.
 *
 * Описано здесь, а не взято из глобального Express.Multer.File: то
 * пространство имён подключается расширением глобальных типов, которое при
 * moduleResolution: nodenext видно не всегда. Нам нужны три поля, и явный
 * тип надёжнее — заодно видно, чем именно мы пользуемся.
 */
interface UploadedFileLike {
  buffer: Buffer;
  originalname?: string;
  size: number;
}

@ApiTags('Конвертация файлов')
@ApiCookieAuth('access_token')
@ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
@ApiResponse({ status: 429, description: 'Превышен лимит запросов' })
@Controller('api/convert')
@UseGuards(RateLimitGuard, JwtAuthGuard)
export class ConvertController {
  constructor(private readonly convertService: ConvertService) {}

  /**
   * GET /api/convert/formats — какие направления поддерживаются.
   *
   * Список собирается из зарегистрированных модулей, а не задан константой:
   * добавится новый конвертер — он появится здесь сам.
   */
  @ApiOperation({
    summary: 'Поддерживаемые направления конвертации',
    description: 'Собирается из зарегистрированных модулей трансформации.',
  })
  @ApiResponse({
    status: 200,
    description: 'Массив { source, target[] }',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string', example: 'xml' },
          target: {
            type: 'array',
            items: { type: 'string' },
            example: ['csv', 'json', 'yaml'],
          },
        },
      },
    },
  })
  @Get('formats')
  @RateLimit({ limit: 60, windowSeconds: 60 })
  formats(): SupportedDirection[] {
    return this.convertService.supportedFormats();
  }

  /**
   * POST /api/convert — сконвертировать файл.
   *
   * Возвращаем StreamableFile, а не Buffer: Buffer из обработчика Nest
   * прогоняет через обычный сериализатор ответа, и клиент получает
   * {"type":"Buffer","data":[60,63,...]} вместо файла. StreamableFile
   * отдаётся телом как есть и сам проставляет Content-Type и
   * Content-Disposition — это и есть «потоковый файл» из ТЗ.
   */
  @ApiOperation({
    summary: 'Конвертировать файл',
    description:
      'Исходный формат определяется по содержимому. Лимит размера свой ' +
      'для каждого формата и задаётся в конфигурации. Разбор идёт в ' +
      'отдельном потоке с таймаутом.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'targetFormat'],
      properties: {
        file: { type: 'string', format: 'binary' },
        targetFormat: { type: 'string', enum: ['csv', 'json', 'xml', 'yaml'] },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Файл в целевом формате' })
  @ApiResponse({
    status: 400,
    description: 'Пустой или синтаксически неверный файл',
  })
  @ApiResponse({
    status: 413,
    description: 'Превышен лимит размера для формата',
  })
  @ApiResponse({
    status: 415,
    description: 'Формат или направление не поддерживаются',
  })
  @ApiResponse({
    status: 504,
    description: 'Конвертация не уложилась в таймаут',
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
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body(new ZodValidationPipe(convertSchema)) dto: ConvertDto,
    @CurrentUser() me: User,
  ): Promise<StreamableFile> {
    if (!file) {
      throw new BadRequestException('Файл обязателен');
    }

    const result = await this.convertService.convert(
      me.id,
      file,
      dto.targetFormat,
    );

    return new StreamableFile(result.body, {
      type: result.mime,
      disposition: `attachment; filename="${result.filename}"`,
      length: result.body.byteLength,
    });
  }
}
