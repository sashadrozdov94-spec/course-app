import {
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { HistoryWriteService } from '../transformations/history-write.service.js';
import { TransformationType } from '../transformations/transformation.js';
import { CONVERTERS, findConverter } from './converters/index.js';
import { FileFormat, FORMAT_BY_EXTENSION, MIME_BY_FORMAT } from './format.js';
import { detectFormat } from './format-detector.js';
import { ConversionRunner } from './worker/conversion-runner.service.js';

/** Готовый к отдаче результат. */
export interface ConversionResult {
  body: Buffer;
  mime: string;
  filename: string;
}

/** Одно направление в ответе GET /api/convert/formats. */
export interface SupportedDirection {
  source: string;
  target: string[];
}

/** Байт-порядок в начале файла. Не данные, а метка кодировки. */
const BOM = '﻿';

@Injectable()
export class ConvertService {
  private readonly maxBytes: Readonly<Record<FileFormat, number>>;

  constructor(
    /**
     * Журнал и история п. 1.5 — общие с трансформацией изображений.
     *
     * Своей таблицы у этого модуля больше нет: п. 1.1 ТЗ про историю
     * требует единого хранилища, а из двух таблиц одну страницу с курсором
     * не собрать. Содержимое файлов туда по-прежнему не попадает — только
     * форматы, размеры и результат.
     */
    private readonly history: HistoryWriteService,
    private readonly runner: ConversionRunner,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = {
      [FileFormat.Csv]: config.get('CONVERT_MAX_CSV_BYTES', { infer: true }),
      [FileFormat.Json]: config.get('CONVERT_MAX_JSON_BYTES', { infer: true }),
      [FileFormat.Xml]: config.get('CONVERT_MAX_XML_BYTES', { infer: true }),
      [FileFormat.Yaml]: config.get('CONVERT_MAX_YAML_BYTES', { infer: true }),
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
   * Конвертация файла (п. 1.3.1 ТЗ).
   *
   * Порядок шагов выбран так, чтобы дешёвые проверки шли раньше дорогих:
   * сначала формат и размер, и только потом разбор — самое затратное.
   */
  async convert(
    userId: string,
    file: { buffer: Buffer; originalname?: string; size: number },
    targetFormat: string,
    save = false,
  ): Promise<ConversionResult> {
    const startedAt = Date.now();
    const sourceName = file.originalname ?? null;

    /** Общая часть каждой записи в историю. */
    const entry = {
      userId,
      type: TransformationType.File,
      sourceName,
      targetFormat,
      fileSize: file.size,
      startedAt,
    };

    // 1. Текст и кодировка. BOM убираем: для JSON.parse он посторонний
    //    символ, и файл из Windows-редактора иначе не разобрался бы.
    const text = this.decode(file.buffer);

    // 2. Исходный формат — по содержимому, с подсказкой из расширения
    const source = detectFormat(text, this.extensionOf(sourceName));

    if (!source) {
      await this.history.record({
        ...entry,
        sourceFormat: null,
        statusCode: 415,
        error: 'формат не распознан',
      });
      throw new UnsupportedMediaTypeException(
        'Не удалось определить формат файла. Поддерживаются CSV, JSON, XML и YAML. ' +
          'Укажите расширение в имени файла, если формат определяется неоднозначно',
      );
    }

    // 3. Лимит размера — свой для каждого исходного формата
    const limit = this.maxBytes[source];

    if (file.size > limit) {
      await this.history.record({
        ...entry,
        sourceFormat: source,
        statusCode: 413,
        error: `больше лимита ${limit} байт`,
      });
      throw new PayloadTooLargeException(
        `Файл ${source} больше допустимых ${Math.floor(limit / 1024)} КиБ`,
      );
    }

    // 4. Направление должно поддерживаться
    if (!findConverter(source, targetFormat)) {
      await this.history.record({
        ...entry,
        sourceFormat: source,
        statusCode: 415,
        error: 'направление не поддерживается',
      });
      throw new UnsupportedMediaTypeException(
        `Направление ${source} → ${targetFormat} не поддерживается`,
      );
    }

    if (text.trim().length === 0) {
      await this.history.record({
        ...entry,
        sourceFormat: source,
        statusCode: 400,
        error: 'пустой файл',
      });
      throw new BadRequestException('Файл пуст');
    }

    // 5. Сам разбор — в отдельном потоке, с таймаутом
    const result = await this.runner.run(source, targetFormat, text);

    if (!result.ok) {
      const statusCode = result.timedOut ? 504 : 400;

      await this.history.record({
        ...entry,
        sourceFormat: source,
        statusCode,
        error: result.error ?? 'ошибка конвертации',
      });

      // Ответ атомарен (п. 1.6 ТЗ): при ошибке клиент получает только
      // сообщение, никакого частичного файла.
      if (result.timedOut) {
        throw new GatewayTimeoutException(
          'Файл не удалось обработать за отведённое время',
        );
      }

      throw new BadRequestException(
        result.error ?? 'Не удалось преобразовать файл',
      );
    }

    const body = Buffer.from(result.output ?? '', 'utf8');
    const mime = MIME_BY_FORMAT[targetFormat as FileFormat];
    const filename = `converted.${targetFormat}`;

    // Запись истории идёт до ответа, а не после: только так отказ
    // хранилища превращается в 500, как требует п. 1.4 ТЗ. Отдать файл и
    // потом молча не сохранить его значило бы соврать — человек увидел
    // бы в истории запись без обещанного файла.
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

  /**
   * Байты → строка.
   *
   * Работаем только с UTF-8: ТЗ требует именно его. Некорректные
   * последовательности Node заменяет символом U+FFFD, поэтому проверяем
   * результат — иначе файл в cp1251 молча превратился бы в мусор, и
   * человек узнал бы об этом уже по испорченным данным.
   */
  private decode(buffer: Buffer): string {
    const text = buffer.toString('utf8');
    const withoutBom = text.startsWith(BOM) ? text.slice(BOM.length) : text;

    if (withoutBom.includes('�')) {
      throw new BadRequestException('Файл не в кодировке UTF-8 либо повреждён');
    }

    return withoutBom;
  }

  private extensionOf(name: string | null): FileFormat | undefined {
    if (!name) {
      return undefined;
    }

    const dot = name.lastIndexOf('.');

    return dot < 0
      ? undefined
      : FORMAT_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
  }
}
