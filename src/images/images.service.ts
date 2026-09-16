import {
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { HistoryWriteService } from '../transformations/history-write.service.js';
import { TransformationType } from '../transformations/transformation.js';
import { ConversionError } from './conversion-error.js';
import { CONVERTERS, findConverter } from './converters/index.js';
import type { ConversionSettings, OptionName } from './image-converter.js';
import { OPTION_NAMES } from './image-converter.js';
import { ImageFormat, MIME_BY_FORMAT } from './image-format.js';
import { detectFormat, formatByFilename } from './image-detector.js';
import type { ImageOptions } from './dto/convert-image.dto.js';

/** Готовый к отдаче результат. */
export interface ConversionResult {
  body: Buffer;
  mime: string;
  filename: string;
}

/** Одно направление в ответе GET /api/images/convert/formats. */
export interface SupportedDirection {
  source: string;
  target: string[];
}

/**
 * Отказ: записать в журнал и ответить нужным кодом.
 *
 * Тип объявлен отдельно не для красоты. Чтобы TypeScript считал код после
 * вызова недостижимым — и знал, например, что дальше source уже не
 * null, — функция должна быть константой с явно указанным типом. Вывод
 * типа из тела для этого не годится: проверка идёт по объявлению.
 */
type Fail = (
  status: number,
  reason: string,
  source?: ImageFormat | null,
) => never;

/** Что кладёт multer в @UploadedFile. */
export interface UploadedImage {
  buffer: Buffer;
  originalname?: string;
  size: number;
}

/**
 * Сообщения библиотеки обработки изображений, у которых есть понятная
 * причина на стороне клиента.
 *
 * Наружу они не уходят: это английский текст про внутренности libvips.
 * Но сказать «файл не изображение» вместо «не удалось обработать» стоит —
 * по первому видно, что делать дальше.
 *
 * Всё, чего в таблице нет, — неожиданность, и клиенту сообщается общими
 * словами; подробности остаются в журнале приложения.
 */
const KNOWN_FAILURES: readonly { pattern: RegExp; message: string }[] = [
  {
    pattern: /unsupported image format|bad extract area|corrupt|premature end/i,
    message: 'Файл не является корректным изображением этого формата',
  },
  {
    pattern: /exceeds pixel limit/i,
    message:
      'Изображение слишком большое: в нём больше пикселей, чем разрешено ' +
      'для обработки',
  },
  {
    pattern: /timeout|timed out/i,
    message: 'Изображение не удалось обработать за отведённое время',
  },
  {
    pattern: /unable to parse|svgload/i,
    message: 'Не удалось разобрать разметку SVG',
  },
];

@Injectable()
export class ImagesService {
  /** Только для неожиданностей: сама история пишется в history. */
  private readonly logger = new Logger('Images');

  /** Лимит размера на каждый исходный формат (п. 1.1 ТЗ). */
  private readonly maxBytes: Readonly<Record<ImageFormat, number>>;

  private readonly settings: ConversionSettings;

  constructor(
    /**
     * История п. 1.5 — общая с конвертацией файлов.
     *
     * Своей таблицы у модуля нет: история всех трансформаций лежит в
     * одном месте, иначе её не показать одной страницей с курсором.
     * Содержимого изображений туда не попадает — только форматы, размер,
     * результат и длительность. Это прямое требование ТЗ, и оно разумно: в
     * картинке бывает что угодно, вплоть до сканов документов.
     */
    private readonly history: HistoryWriteService,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = {
      [ImageFormat.Png]: config.get('IMAGE_MAX_PNG_BYTES', { infer: true }),
      [ImageFormat.Jpeg]: config.get('IMAGE_MAX_JPEG_BYTES', { infer: true }),
      [ImageFormat.Svg]: config.get('IMAGE_MAX_SVG_BYTES', { infer: true }),
    };

    this.settings = {
      maxWidth: config.get('IMAGE_MAX_WIDTH', { infer: true }),
      maxHeight: config.get('IMAGE_MAX_HEIGHT', { infer: true }),
      maxPixels: config.get('IMAGE_MAX_PIXELS', { infer: true }),
      defaultSize: config.get('IMAGE_DEFAULT_SIZE', { infer: true }),
      timeoutMs: config.get('IMAGE_TIMEOUT_MS', { infer: true }),
      defaultQuality: config.get('IMAGE_JPEG_QUALITY', { infer: true }),
      defaultBackground: config.get('IMAGE_BACKGROUND', { infer: true }),
    };
  }

  /** Все поддерживаемые направления (п. 1.3.2 ТЗ). */
  supportedFormats(): SupportedDirection[] {
    const bySource = new Map<string, string[]>();

    for (const converter of CONVERTERS) {
      const targets = bySource.get(converter.source) ?? [];
      targets.push(converter.target);
      bySource.set(converter.source, targets);
    }

    return [...bySource].map(([source, target]) => ({ source, target }));
  }

  /**
   * Конвертация изображения (п. 1.3.1 ТЗ).
   *
   * Порядок шагов выбран так, чтобы дешёвые проверки шли раньше дорогих:
   * сначала формат, размер и направление — всё это стоит микросекунды, —
   * и только потом декодирование, самое затратное.
   */
  async convert(
    userId: string,
    file: UploadedImage,
    targetFormat: ImageFormat,
    options: ImageOptions,
    save = false,
  ): Promise<ConversionResult> {
    const startedAt = Date.now();

    /** Общая часть каждой записи в историю. */
    const entry = {
      userId,
      type: TransformationType.Image,
      sourceName: file.originalname ?? null,
      targetFormat,
      fileSize: file.size,
      startedAt,
    };

    /**
     * Отказ: записать в журнал и ответить нужным кодом.
     *
     * Возвращает never, поэтому после вызова TypeScript считает код
     * недостижимым — и знает, например, что ниже source уже не null.
     */
    const fail: Fail = (status, reason, source = null) => {
      // Запись истории не ждём: клиент уже получает отказ, и задерживать
      // его ради строки в базе незачем. Свои ошибки запись ловит сама
      void this.history.record({
        ...entry,
        sourceFormat: source,
        statusCode: status,
        error: reason,
      });

      throw exceptionFor(status, reason);
    };

    if (file.size === 0) {
      fail(400, 'Файл пуст');
    }

    // 1. Исходный формат — по содержимому, с подсказкой из расширения
    const source = detectFormat(
      file.buffer,
      formatByFilename(entry.sourceName),
    );

    if (!source) {
      fail(
        415,
        'Не удалось определить формат файла. Поддерживаются PNG, JPEG и SVG',
      );
    }

    // 2. Лимит размера — свой для каждого исходного формата
    const limit = this.maxBytes[source];

    if (file.size > limit) {
      fail(
        413,
        `Файл ${source} больше допустимых ${Math.floor(limit / 1024)} КиБ`,
        source,
      );
    }

    // 3. Направление должно поддерживаться. Здесь 400, а не 415: формат
    //    файла нам знаком и понятен, невозможна именно эта пара — ровно
    //    так разделены коды в п. 1.3.1 ТЗ
    const converter = findConverter(source, targetFormat);

    if (!converter) {
      fail(
        400,
        `Направление ${source} → ${targetFormat} не поддерживается` +
          (targetFormat === ImageFormat.Svg
            ? ': превратить растр в вектор нельзя'
            : ''),
        source,
      );
    }

    // 4. Параметры, которых это направление не понимает, — отказ, а не
    //    молчание: иначе клиент получил бы картинку не того размера или
    //    не того качества и не узнал бы почему
    const extra = unsupportedOptions(options, converter.accepts);

    if (extra.length > 0) {
      fail(
        400,
        `Направление ${converter.direction} не принимает параметры: ` +
          `${extra.join(', ')}. Принимаются: ` +
          (converter.accepts.join(', ') || 'никакие'),
        source,
      );
    }

    // 5. Само преобразование
    let body: Buffer;

    try {
      body = await converter.convert(file.buffer, options, this.settings);
    } catch (error) {
      const reason = describe(error);

      this.logger.warn(
        `Конвертация ${converter.direction} не удалась: ${String(error)}`,
      );

      fail(400, reason, source);
    }

    const mime = MIME_BY_FORMAT[targetFormat];
    const filename = `converted.${targetFormat}`;

    // Запись истории идёт до ответа, а не после: только так отказ
    // хранилища превращается в 500, как требует п. 1.4 ТЗ
    await this.history.record({
      ...entry,
      sourceFormat: source,
      resultSize: body.byteLength,
      statusCode: 200,
      save: save
        ? { body, name: filename, mime, extension: targetFormat }
        : undefined,
    });

    return { body, mime, filename };
  }
}

/**
 * Какие из переданных параметров направление не понимает.
 *
 * Считаем по списку известных имён, а не по ключам объекта: схема уже
 * отклонила всё постороннее, и здесь остаются только настоящие параметры,
 * просто не те.
 */
function unsupportedOptions(
  options: ImageOptions,
  accepts: readonly OptionName[],
): OptionName[] {
  return OPTION_NAMES.filter(
    (name) => options[name] !== undefined && !accepts.includes(name),
  );
}

/**
 * Что показать клиенту, если преобразование не удалось.
 *
 * Свои отказы (ConversionError) объясняют причину по-русски и уходят как
 * есть. Чужие — это сообщения библиотеки: разбираем те, у которых причина
 * на стороне клиента, остальные обобщаем. Подробности всё равно остаются
 * в журнале приложения.
 */
function describe(error: unknown): string {
  if (error instanceof ConversionError) {
    return error.message;
  }

  const text = error instanceof Error ? error.message : String(error);
  const known = KNOWN_FAILURES.find((entry) => entry.pattern.test(text));

  return known?.message ?? 'Не удалось обработать изображение';
}

/** Код ответа → исключение Nest. */
function exceptionFor(status: number, message: string): Error {
  switch (status) {
    case 413:
      return new PayloadTooLargeException(message);
    case 415:
      return new UnsupportedMediaTypeException(message);
    default:
      return new BadRequestException(message);
  }
}
