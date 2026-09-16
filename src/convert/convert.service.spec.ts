import {
  BadRequestException,
  GatewayTimeoutException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import type { HistoryWriteService } from '../transformations/history-write.service.js';
import type { TransformationRecord } from '../transformations/history-write.service.js';
import { ConvertService } from './convert.service.js';
import type {
  ConversionRunner,
  RunResult,
} from './worker/conversion-runner.service.js';

const USER = 'user-1';

/** Лимиты: маленькие, чтобы превышение проверялось на коротких строках. */
const LIMITS: Record<string, number> = {
  CONVERT_MAX_CSV_BYTES: 1_000,
  CONVERT_MAX_JSON_BYTES: 1_000,
  CONVERT_MAX_XML_BYTES: 1_000,
  CONVERT_MAX_YAML_BYTES: 50,
};

/** Загруженный файл, как его отдаёт multer. */
function upload(text: string, originalname?: string) {
  const buffer = Buffer.from(text, 'utf8');

  return { buffer, originalname, size: buffer.byteLength };
}

/** Собрать сервис с заданным поведением рабочего потока. */
function setup(result: RunResult = { ok: true, output: '[]' }) {
  const records: TransformationRecord[] = [];

  const history = {
    record: (entry: TransformationRecord) => {
      records.push(entry);
      return Promise.resolve();
    },
  } as unknown as HistoryWriteService;

  const runner = {
    run: () => Promise.resolve(result),
  } as unknown as ConversionRunner;

  return {
    records,
    service: new ConvertService(history, runner, {
      get: (key: string) => LIMITS[key],
    } as unknown as ConfigService<Env, true>),
  };
}

describe('Список направлений', () => {
  it('собирается из зарегистрированных, по одному источнику на строку', () => {
    const directions = setup().service.supportedFormats();

    expect(directions).toHaveLength(4);
    expect(directions).toContainEqual({
      source: 'csv',
      target: ['json', 'xml', 'yaml'],
    });
  });
});

describe('Конвертация файла', () => {
  it('отдаёт результат с типом и именем', async () => {
    const { service } = setup({ ok: true, output: '[{"a":1}]' });

    const result = await service.convert(
      USER,
      upload('a\r\n1\r\n', 'data.csv'),
      'json',
    );

    expect(result.body.toString('utf8')).toBe('[{"a":1}]');
    expect(result.mime).toContain('application/json');
    expect(result.filename).toBe('converted.json');
  });

  it('пишет в историю успех с размерами', async () => {
    const { service, records } = setup({ ok: true, output: '[]' });

    await service.convert(USER, upload('a\r\n1\r\n', 'data.csv'), 'json');

    expect(records[0]).toMatchObject({
      userId: USER,
      type: 'file',
      sourceFormat: 'csv',
      targetFormat: 'json',
      statusCode: 200,
      resultSize: 2,
    });
  });

  it('по просьбе передаёт результат на сохранение', async () => {
    const { service, records } = setup({ ok: true, output: '[]' });

    await service.convert(USER, upload('a\r\n1\r\n', 'data.csv'), 'json', true);

    expect(records[0]!.save).toMatchObject({
      name: 'converted.json',
      extension: 'json',
    });
  });

  it('без просьбы сохранять ничего не передаёт', async () => {
    const { service, records } = setup();

    await service.convert(USER, upload('a\r\n1\r\n', 'data.csv'), 'json');

    expect(records[0]!.save).toBeUndefined();
  });

  describe('Отказы', () => {
    it('нераспознанный формат — 415, и это попадает в историю', async () => {
      const { service, records } = setup();

      await expect(
        service.convert(USER, upload('%PDF-1.4 бинарь'), 'json'),
      ).rejects.toThrow(UnsupportedMediaTypeException);

      expect(records[0]).toMatchObject({ sourceFormat: null, statusCode: 415 });
    });

    it('неподдерживаемое направление — 415', async () => {
      const { service, records } = setup();

      // json → json это переформатирование, а не конвертация
      await expect(
        service.convert(USER, upload('{"a":1}', 'data.json'), 'json'),
      ).rejects.toThrow(/не поддерживается/);

      expect(records[0]).toMatchObject({ statusCode: 415 });
    });

    it('превышение лимита — 413 с размером в килобайтах', async () => {
      const { service, records } = setup();
      const big = `a: ${'ж'.repeat(200)}\n`;

      await expect(
        service.convert(USER, upload(big, 'data.yaml'), 'json'),
      ).rejects.toThrow(PayloadTooLargeException);

      expect(records[0]).toMatchObject({
        sourceFormat: 'yaml',
        statusCode: 413,
      });
    });

    it('пустой файл — 400', async () => {
      const { service, records } = setup();

      await expect(
        service.convert(USER, upload('   \n  ', 'data.csv'), 'json'),
      ).rejects.toThrow(BadRequestException);

      expect(records[0]).toMatchObject({
        statusCode: 400,
        error: 'пустой файл',
      });
    });

    it('ошибка разбора — 400 с текстом от конвертера', async () => {
      const { service } = setup({ ok: false, error: 'неожиданный символ' });

      await expect(
        service.convert(USER, upload('{"a":1}', 'data.json'), 'csv'),
      ).rejects.toThrow(/неожиданный символ/);
    });

    it('таймаут — 504, а не 400', async () => {
      const { service, records } = setup({
        ok: false,
        timedOut: true,
        error: 'долго',
      });

      await expect(
        service.convert(USER, upload('{"a":1}', 'data.json'), 'csv'),
      ).rejects.toThrow(GatewayTimeoutException);

      expect(records[0]).toMatchObject({ statusCode: 504 });
    });

    it('файл не в UTF-8 — 400, а не мусор в ответе', async () => {
      const { service } = setup();
      // 0xFF в UTF-8 не встречается: Node заменит его на U+FFFD
      const broken = { buffer: Buffer.from([0xff, 0xfe, 0x41]), size: 3 };

      await expect(service.convert(USER, broken, 'json')).rejects.toThrow(
        /UTF-8/,
      );
    });
  });

  describe('Определение формата', () => {
    it('расширение подсказывает, когда содержимое неоднозначно', async () => {
      const { service, records } = setup();

      // Строка из одной колонки одинаково подходит под CSV и YAML
      await service.convert(USER, upload('{"a":1}', 'data.yaml'), 'json');

      expect(records[0]!.sourceFormat).toBe('yaml');
    });

    it('без имени файла опирается только на содержимое', async () => {
      const { service, records } = setup();

      await service.convert(USER, upload('<a><b>1</b></a>'), 'json');

      expect(records[0]!.sourceFormat).toBe('xml');
    });

    it('имя без точки не мешает', async () => {
      const { service, records } = setup();

      await service.convert(USER, upload('<a/>', 'файлбезточки'), 'json');

      expect(records[0]!.sourceFormat).toBe('xml');
    });

    it('метка кодировки в начале не ломает разбор', async () => {
      const { service, records } = setup();

      await service.convert(USER, upload('﻿{"a":1}', 'data.json'), 'csv');

      expect(records[0]!.sourceFormat).toBe('json');
    });
  });
});
