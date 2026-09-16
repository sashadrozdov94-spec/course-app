import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { DiskFileStorage } from './disk-file-storage.js';

/** Настоящий каталог во временной папке: хранилище работает с диском. */
let root: string;
let storage: DiskFileStorage;

/** Поток целиком в память — в тестах файлы крошечные. */
async function read(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'storage-test-'));

  // Конфигурация здесь нужна ровно одним значением — где корень
  // хранилища. Поднимать ради него настоящий ConfigService значило бы
  // тащить в тест про файлы весь разбор .env
  storage = new DiskFileStorage({
    get: () => root,
  } as unknown as ConstructorParameters<typeof DiskFileStorage>[0]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Хранилище на диске', () => {
  it('кладёт файл и отдаёт его обратно', async () => {
    const key = await storage.put(Buffer.from('привет'), 'json');
    const stream = await storage.open(key);

    expect(stream).not.toBeNull();
    expect(await read(stream!)).toBe('привет');
  });

  it('раскладывает файлы по вложенным папкам', async () => {
    const key = await storage.put(Buffer.from('x'), 'png');

    // Каталог с сотней тысяч файлов в одном уровне работает плохо
    expect(key).toMatch(/^[0-9a-f]{2}\/[0-9a-f-]{36}\.png$/);
  });

  it('даёт каждому файлу свой ключ', async () => {
    const first = await storage.put(Buffer.from('одно и то же'), 'json');
    const second = await storage.put(Buffer.from('одно и то же'), 'json');

    expect(first).not.toBe(second);
    expect(await read((await storage.open(first))!)).toBe('одно и то же');
    expect(await read((await storage.open(second))!)).toBe('одно и то же');
  });

  it('не оставляет временных файлов после записи', async () => {
    const key = await storage.put(Buffer.from('данные'), 'json');
    const dir = join(root, 'transformations', key.slice(0, 2));

    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('сохраняет двоичное содержимое байт в байт', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x1a]);
    const key = await storage.put(bytes, 'png');
    const path = join(root, 'transformations', key);

    expect(await readFile(path)).toEqual(bytes);
  });

  it('удаляет файл и переживает повторное удаление', async () => {
    const key = await storage.put(Buffer.from('x'), 'json');

    expect(await storage.remove(key)).toBe(true);
    // Уборка обязана быть повторяемой: второй заход не должен падать
    expect(await storage.remove(key)).toBe(false);
    expect(await storage.open(key)).toBeNull();
  });

  it('на несуществующий файл отвечает null, а не ошибкой', async () => {
    const missing = '00/00000000-0000-4000-8000-000000000000.json';

    expect(await storage.open(missing)).toBeNull();
  });

  describe('Ключ не того вида', () => {
    // Ключи пишем мы сами, но в колонку однажды попадёт что-нибудь не то —
    // руками, миграцией, восстановлением из бэкапа. Собрать путь из такой
    // строки значит дать прочитать или удалить любой файл на диске
    const bad = [
      ['выход вверх', '../../../etc/passwd'],
      ['выход через сегмент', '00/../../../etc/passwd'],
      ['абсолютный путь', '/etc/passwd'],
      ['путь Windows', 'C:\\windows\\win.ini'],
      ['без папки', '00000000-0000-4000-8000-000000000000.json'],
      ['пустая строка', ''],
      ['обратные слэши', '00\\00000000-0000-4000-8000-000000000000'],
    ] as const;

    it.each(bad)('не читает по ключу: %s', async (_name, key) => {
      expect(await storage.open(key)).toBeNull();
    });

    it.each(bad)('не удаляет по ключу: %s', async (_name, key) => {
      expect(await storage.remove(key)).toBe(false);
    });

    it('не удаляет посторонний файл рядом с хранилищем', async () => {
      const outside = join(root, 'секрет.txt');

      await writeFile(outside, 'не трогать');
      await storage.remove('../секрет.txt');

      expect(await readFile(outside, 'utf8')).toBe('не трогать');
    });
  });

  it('обходится без расширения, если оно негодное', async () => {
    const key = await storage.put(Buffer.from('x'), '../json');

    expect(key).not.toContain('..');
    expect(await storage.open(key)).not.toBeNull();
  });
});
