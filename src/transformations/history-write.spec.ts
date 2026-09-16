import {
  InternalServerErrorException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import type { Readable } from 'node:stream';
import type { Repository } from 'typeorm';
import { FileStorage } from '../storage/file-storage.js';
import type { Transformation } from './entities/transformation.entity.js';
import {
  HistoryWriteService,
  type TransformationRecord,
} from './history-write.service.js';
import { TransformationType } from './transformation.js';

/** Настройки, как их отдал бы ConfigService. */
const SETTINGS: Record<string, number> = {
  TRANSFORMATION_MAX_SAVE_BYTES: 1_000,
  TRANSFORMATION_HISTORY_RETENTION_DAYS: 90,
};

/** Репозиторий, который запоминает сохранённые строки. */
function repository(): {
  rows: Partial<Transformation>[];
  repo: Repository<Transformation>;
  failNextSave(): void;
} {
  const rows: Partial<Transformation>[] = [];
  let failNext = false;

  return {
    rows,
    failNextSave() {
      failNext = true;
    },
    repo: {
      create: (row: Partial<Transformation>) => row,
      save: (row: Partial<Transformation>) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('база недоступна'));
        }

        rows.push(row);
        return Promise.resolve(row);
      },
    } as unknown as Repository<Transformation>,
  };
}

/** Хранилище, которое помнит, что в него клали и что из него убирали. */
class FakeStorage extends FileStorage {
  readonly saved = new Map<string, Buffer>();
  readonly removed: string[] = [];
  failPut = false;
  private counter = 0;

  put(body: Buffer, extension: string): Promise<string> {
    if (this.failPut) {
      return Promise.reject(new Error('диск переполнен'));
    }

    this.counter += 1;
    const key = `aa/файл-${this.counter}.${extension}`;
    this.saved.set(key, body);

    return Promise.resolve(key);
  }

  open(): Promise<Readable | null> {
    return Promise.resolve(null);
  }

  remove(key: string): Promise<boolean> {
    this.removed.push(key);
    return Promise.resolve(this.saved.delete(key));
  }
}

/** Заготовка удачной трансформации. */
function entry(
  overrides: Partial<TransformationRecord> = {},
): TransformationRecord {
  return {
    userId: 'user-1',
    type: TransformationType.File,
    sourceName: 'data.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    fileSize: 100,
    resultSize: 50,
    statusCode: 200,
    startedAt: Date.now(),
    ...overrides,
  };
}

let storage: FakeStorage;
let db: ReturnType<typeof repository>;
let service: HistoryWriteService;

beforeEach(() => {
  storage = new FakeStorage();
  db = repository();

  service = new HistoryWriteService(db.repo, storage, {
    get: (key: string) => SETTINGS[key],
  } as unknown as ConfigService<Env, true>);
});

describe('Запись истории', () => {
  it('пишет строку с форматами, размерами и длительностью', async () => {
    await service.record(entry({ startedAt: Date.now() - 25 }));

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      userId: 'user-1',
      type: TransformationType.File,
      sourceFormat: 'csv',
      targetFormat: 'json',
      fileSize: 100,
      resultSize: 50,
      status: 'success',
      statusCode: 200,
    });
    expect(db.rows[0]!.durationMs).toBeGreaterThanOrEqual(20);
  });

  it('неопознанный формат записывает как unknown, а не теряет строку', async () => {
    // По таким записям и видно, что кто-то систематически шлёт не то
    await service.record(entry({ sourceFormat: null, statusCode: 415 }));

    expect(db.rows[0]).toMatchObject({
      sourceFormat: 'unknown',
      status: 'error',
      statusCode: 415,
    });
  });

  it('отказ — тоже строка истории', async () => {
    await service.record(
      entry({ statusCode: 413, error: 'больше лимита', resultSize: undefined }),
    );

    expect(db.rows[0]).toMatchObject({
      status: 'error',
      statusCode: 413,
      error: 'больше лимита',
      resultSize: null,
    });
  });

  it('обрезает слишком длинные имя и причину, а не падает на них', async () => {
    await service.record(
      entry({
        sourceName: 'и'.repeat(500),
        statusCode: 400,
        error: 'о'.repeat(500),
      }),
    );

    expect(db.rows[0]!.sourceName).toHaveLength(255);
    expect(db.rows[0]!.error).toHaveLength(255);
  });

  it('упавшая запись в базу не роняет уже сделанную работу', async () => {
    db.failNextSave();

    // Файл человек получит; о потерянной строке скажет журнал
    await expect(service.record(entry())).resolves.toBeUndefined();
    expect(db.rows).toHaveLength(0);
  });
});

describe('Сохранение результата', () => {
  const saved = {
    body: Buffer.from('{"a":1}'),
    name: 'converted.json',
    mime: 'application/json',
    extension: 'json',
  };

  it('кладёт файл и запоминает ключ, имя, тип и срок', async () => {
    await service.record(entry({ save: saved }));

    const row = db.rows[0]!;

    expect(storage.saved.size).toBe(1);
    expect(row.fileId).toBe([...storage.saved.keys()][0]);
    expect(row.resultName).toBe('converted.json');
    expect(row.resultMime).toBe('application/json');
    expect(row.expiresAt).toBeInstanceOf(Date);
  });

  it('срок жизни файла равен сроку хранения истории', async () => {
    const before = Date.now();

    await service.record(entry({ save: saved }));

    const expires = db.rows[0]!.expiresAt!.getTime();
    const days = Math.round((expires - before) / (24 * 60 * 60 * 1000));

    expect(days).toBe(SETTINGS.TRANSFORMATION_HISTORY_RETENTION_DAYS);
  });

  it('без просьбы сохранить ничего не кладёт', async () => {
    await service.record(entry());

    expect(storage.saved.size).toBe(0);
    expect(db.rows[0]).toMatchObject({
      fileId: null,
      resultName: null,
      resultMime: null,
      expiresAt: null,
    });
  });

  it('у отказа сохранять нечего, даже если просили', async () => {
    await service.record(entry({ statusCode: 400, save: saved }));

    expect(storage.saved.size).toBe(0);
    expect(db.rows[0]!.fileId).toBeNull();
  });

  it('слишком большой результат — 413 с понятным предложением', async () => {
    const big = {
      ...saved,
      body: Buffer.alloc(SETTINGS.TRANSFORMATION_MAX_SAVE_BYTES! + 1),
    };

    await expect(service.record(entry({ save: big }))).rejects.toThrow(
      PayloadTooLargeException,
    );

    // Лимит проверяется до записи: иначе он не защищал бы диск
    expect(storage.saved.size).toBe(0);
    expect(db.rows).toHaveLength(0);
  });

  it('сбой хранилища превращается в 500, а не в тихую потерю файла', async () => {
    storage.failPut = true;

    await expect(service.record(entry({ save: saved }))).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('наружу не уходят подробности сбоя хранилища', async () => {
    storage.failPut = true;

    await expect(service.record(entry({ save: saved }))).rejects.toThrow(
      /Не удалось сохранить результат/,
    );
  });

  it('если строка не записалась, файл убирается следом', async () => {
    db.failNextSave();

    await service.record(entry({ save: saved }));

    // Файл без строки не найти и не удалить штатной уборкой — он остался
    // бы на диске навсегда
    expect(storage.removed).toHaveLength(1);
    expect(storage.saved.size).toBe(0);
  });

  it('срока нет, когда уборка отключена', async () => {
    const forever = new HistoryWriteService(db.repo, storage, {
      get: (key: string) =>
        key === 'TRANSFORMATION_HISTORY_RETENTION_DAYS' ? 0 : SETTINGS[key],
    } as unknown as ConfigService<Env, true>);

    await forever.record(entry({ save: saved }));

    // Срок истечения без уборки был бы обещанием, которое некому исполнить
    expect(db.rows[0]!.expiresAt).toBeNull();
    expect(db.rows[0]!.fileId).not.toBeNull();
  });
});
