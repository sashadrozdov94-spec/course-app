import {
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { GatewayTimeoutException } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { Env } from '../config/env.schema.js';
import { CONVERTERS, findConverter } from './converters/index.js';
import {
  ConversionStatus,
  FileConversion,
} from './entities/file-conversion.entity.js';
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
  // Журнал п. 1.5. Содержимое файлов сюда не попадает — только форматы,
  // размеры и результат.
  private readonly logger = new Logger('Convert');

  private readonly maxBytes: Readonly<Record<FileFormat, number>>;

  constructor(
    @InjectRepository(FileConversion)
    private readonly history: Repository<FileConversion>,
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
  ): Promise<ConversionResult> {
    const started = Date.now();
    const name = file.originalname ?? null;

    // 1. Текст и кодировка. BOM убираем: для JSON.parse он посторонний
    //    символ, и файл из Windows-редактора иначе не разобрался бы.
    const text = this.decode(file.buffer);

    // 2. Исходный формат — по содержимому, с подсказкой из расширения
    const source = detectFormat(text, this.extensionOf(name));

    if (!source) {
      await this.record({
        userId,
        name,
        source: null,
        target: targetFormat,
        sourceBytes: file.size,
        statusCode: 415,
        started,
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
      await this.record({
        userId,
        name,
        source,
        target: targetFormat,
        sourceBytes: file.size,
        statusCode: 413,
        started,
        error: `больше лимита ${limit} байт`,
      });
      throw new PayloadTooLargeException(
        `Файл ${source} больше допустимых ${Math.floor(limit / 1024)} КиБ`,
      );
    }

    // 4. Направление должно поддерживаться
    if (!findConverter(source, targetFormat)) {
      await this.record({
        userId,
        name,
        source,
        target: targetFormat,
        sourceBytes: file.size,
        statusCode: 415,
        started,
        error: 'направление не поддерживается',
      });
      throw new UnsupportedMediaTypeException(
        `Направление ${source} → ${targetFormat} не поддерживается`,
      );
    }

    if (text.trim().length === 0) {
      await this.record({
        userId,
        name,
        source,
        target: targetFormat,
        sourceBytes: file.size,
        statusCode: 400,
        started,
        error: 'пустой файл',
      });
      throw new BadRequestException('Файл пуст');
    }

    // 5. Сам разбор — в отдельном потоке, с таймаутом
    const result = await this.runner.run(source, targetFormat, text);

    if (!result.ok) {
      const statusCode = result.timedOut ? 504 : 400;

      await this.record({
        userId,
        name,
        source,
        target: targetFormat,
        sourceBytes: file.size,
        statusCode,
        started,
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

    await this.record({
      userId,
      name,
      source,
      target: targetFormat,
      sourceBytes: file.size,
      targetBytes: body.byteLength,
      statusCode: 200,
      started,
    });

    return {
      body,
      mime: MIME_BY_FORMAT[targetFormat as FileFormat],
      filename: `converted.${targetFormat}`,
    };
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

  /**
   * История операции (п. 1.5 ТЗ и требование хранить историю в базе).
   *
   * Пишем и успех, и отказ: по одним успешным записям не видно, что кто-то
   * систематически шлёт битые файлы. Внутри try/catch — упавшая запись в
   * историю не должна отменять уже сделанную работу.
   */
  private async record(data: {
    userId: string;
    name: string | null;
    source: FileFormat | null;
    target: string;
    sourceBytes: number;
    targetBytes?: number;
    statusCode: number;
    started: number;
    error?: string;
  }): Promise<void> {
    const durationMs = Date.now() - data.started;
    const ok = data.statusCode === 200;

    this.logger.log(
      `user=${data.userId} ${data.source ?? '?'} → ${data.target} ` +
        `${data.sourceBytes} байт → ${data.statusCode} за ${durationMs} мс` +
        (data.error ? ` (${data.error})` : ''),
    );

    // Формат не распознан — записывать в колонку с перечислением нечего,
    // а терять запись не хочется: она и говорит, что кто-то шлёт не то.
    if (!data.source) {
      return;
    }

    try {
      await this.history.save(
        this.history.create({
          userId: data.userId,
          sourceName: data.name?.slice(0, 255) ?? null,
          sourceFormat: data.source,
          targetFormat: data.target as FileFormat,
          sourceBytes: data.sourceBytes,
          targetBytes: data.targetBytes ?? null,
          status: ok ? ConversionStatus.Success : ConversionStatus.Error,
          statusCode: data.statusCode,
          error: data.error?.slice(0, 255) ?? null,
          durationMs,
        }),
      );
    } catch (error) {
      this.logger.error(`Не удалось записать историю конвертации: ${error}`);
    }
  }
}
