import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import type { Readable } from 'node:stream';
import type { Repository } from 'typeorm';
import { FileStorage } from '../storage/file-storage.js';
import type { Transformation } from './entities/transformation.entity.js';
import { HistoryRetentionService } from './history-retention.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Строка истории в поддельной базе. */
interface Row {
  id: string;
  fileId: string | null;
  createdAt: Date;
}

/**
 * База в памяти, понимающая ровно то, чем пользуется уборка:
 * «найди просроченное порциями» и «удали вот эти номера».
 */
function database(rows: Row[]) {
  return {
    rows,
    repo: {
      find: (options: {
        where: { createdAt: { value: Date } };
        take: number;
      }) => {
        const before = options.where.createdAt.value;

        return Promise.resolve(
          rows
            .filter((row) => row.createdAt < before)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, options.take)
            .map((row) => ({ id: row.id, fileId: row.fileId })),
        );
      },
      delete: (where: { id: { value: string[] } }) => {
        const ids = new Set(where.id.value);

        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (ids.has(rows[i]!.id)) {
            rows.splice(i, 1);
          }
        }

        return Promise.resolve({ affected: ids.size });
      },
    } as unknown as Repository<Transformation>,
  };
}

/** Хранилище, которое умеет капризничать на заданном ключе. */
class FakeStorage extends FileStorage {
  readonly removed: string[] = [];
  stuck: string | null = null;

  put(): Promise<string> {
    return Promise.resolve('aa/новый');
  }

  open(): Promise<Readable | null> {
    return Promise.resolve(null);
  }

  remove(key: string): Promise<boolean> {
    if (key === this.stuck) {
      return Promise.reject(new Error('файл занят'));
    }

    this.removed.push(key);
    return Promise.resolve(true);
  }
}

/** Уборка с заданным сроком хранения. */
function retentionFor(
  db: ReturnType<typeof database>,
  storage: FileStorage,
  days = 90,
): HistoryRetentionService {
  return new HistoryRetentionService(db.repo, storage, {
    get: (key: string) =>
      key === 'TRANSFORMATION_HISTORY_RETENTION_DAYS' ? days : 24,
  } as unknown as ConfigService<Env, true>);
}

/** Строка возрастом в столько-то дней. */
function aged(id: string, days: number, fileId: string | null = null): Row {
  return { id, fileId, createdAt: new Date(Date.now() - days * DAY_MS) };
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
});

describe('Уборка просроченной истории', () => {
  it('удаляет старое и не трогает свежее', async () => {
    const db = database([aged('old', 100), aged('fresh', 10)]);

    expect(await retentionFor(db, storage).purge()).toBe(1);
    expect(db.rows.map((row) => row.id)).toEqual(['fresh']);
  });

  it('вместе со строкой убирает и файл', async () => {
    const db = database([aged('old', 100, 'aa/файл.json')]);

    await retentionFor(db, storage).purge();

    expect(storage.removed).toEqual(['aa/файл.json']);
    expect(db.rows).toHaveLength(0);
  });

  it('строки без файла убираются так же', async () => {
    const db = database([aged('old', 100, null)]);

    await retentionFor(db, storage).purge();

    expect(storage.removed).toEqual([]);
    expect(db.rows).toHaveLength(0);
  });

  it('обрабатывает больше одной порции', async () => {
    // Порция — 500 строк; берём заведомо больше, чтобы цикл сделал круг
    const many = Array.from({ length: 1_200 }, (_, i) => aged(`old-${i}`, 100));
    const db = database(many);

    expect(await retentionFor(db, storage).purge()).toBe(1_200);
    expect(db.rows).toHaveLength(0);
  });

  it('ничего не делает, когда убирать нечего', async () => {
    const db = database([aged('fresh', 1)]);

    expect(await retentionFor(db, storage).purge()).toBe(0);
    expect(db.rows).toHaveLength(1);
  });

  it('срок считается от настройки, а не от круглого числа', async () => {
    const db = database([aged('old', 8), aged('fresh', 6)]);

    await retentionFor(db, storage, 7).purge();

    expect(db.rows.map((row) => row.id)).toEqual(['fresh']);
  });

  describe('Когда файл убрать не удалось', () => {
    it('строка остаётся: иначе след файла теряется навсегда', async () => {
      const db = database([aged('stuck', 100, 'aa/занят')]);

      storage.stuck = 'aa/занят';

      expect(await retentionFor(db, storage).purge()).toBe(0);
      expect(db.rows.map((row) => row.id)).toEqual(['stuck']);
    });

    it('остальные строки порции всё равно убираются', async () => {
      const db = database([
        aged('stuck', 100, 'aa/занят'),
        aged('ok', 99, 'aa/обычный'),
      ]);

      storage.stuck = 'aa/занят';

      await retentionFor(db, storage).purge();

      expect(db.rows.map((row) => row.id)).toEqual(['stuck']);
      expect(storage.removed).toEqual(['aa/обычный']);
    });

    it('на следующем заходе пробует снова', async () => {
      const db = database([aged('stuck', 100, 'aa/занят')]);
      const retention = retentionFor(db, storage);

      storage.stuck = 'aa/занят';
      await retention.purge();
      expect(db.rows).toHaveLength(1);

      // Файл освободился
      storage.stuck = null;
      expect(await retention.purge()).toBe(1);
      expect(db.rows).toHaveLength(0);
    });
  });

  it('недоступная база не роняет приложение', async () => {
    const broken = {
      find: () => Promise.reject(new Error('база недоступна')),
    } as unknown as Repository<Transformation>;

    const retention = new HistoryRetentionService(broken, storage, {
      get: () => 90,
    } as unknown as ConfigService<Env, true>);

    await expect(retention.purge()).resolves.toBe(0);
  });
});

describe('Запуск и остановка уборки', () => {
  it('при старте сразу убирает просроченное, не дожидаясь таймера', async () => {
    const db = database([aged('old', 100)]);
    const retention = retentionFor(db, storage);

    retention.onModuleInit();
    // Первый проход запускается без ожидания — даём ему завершиться
    await Promise.resolve();
    await Promise.resolve();
    retention.onModuleDestroy();

    expect(db.rows).toHaveLength(0);
  });

  it('с нулевым сроком не удаляет ничего и таймер не заводит', async () => {
    const db = database([aged('ancient', 10_000, 'aa/файл')]);
    const retention = retentionFor(db, storage, 0);

    retention.onModuleInit();
    await Promise.resolve();
    retention.onModuleDestroy();

    expect(db.rows).toHaveLength(1);
    expect(storage.removed).toEqual([]);
  });

  it('остановка без запуска ничего не ломает', () => {
    const retention = retentionFor(database([]), storage);

    expect(() => retention.onModuleDestroy()).not.toThrow();
  });
});
