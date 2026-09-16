import {
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import type { Repository } from 'typeorm';
import type { RbacService } from '../rbac/rbac.service.js';
import { FileStorage } from '../storage/file-storage.js';
import type { User } from '../users/entities/user.entity.js';
import type { UsersService } from '../users/users.service.js';
import type { Transformation } from './entities/transformation.entity.js';
import {
  HistoryDownloadService,
  toStreamable,
} from './history-download.service.js';
import { TransformationStatus, TransformationType } from './transformation.js';

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const ADMIN = 'user-admin';
const ITEM = 'item-1';

/** Запись с сохранённым файлом. */
function record(overrides: Partial<Transformation> = {}): Transformation {
  return {
    id: ITEM,
    userId: OWNER,
    type: TransformationType.File,
    sourceName: 'секрет.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    status: TransformationStatus.Success,
    statusCode: 200,
    fileSize: 100,
    resultSize: 42,
    error: null,
    durationMs: 5,
    createdAt: new Date(),
    fileId: 'aa/файл.json',
    resultName: 'converted.json',
    resultMime: 'application/json',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Transformation;
}

/** Хранилище, в котором лежит ровно один известный файл. */
class FakeStorage extends FileStorage {
  constructor(private readonly present = true) {
    super();
  }

  put(): Promise<string> {
    return Promise.resolve('aa/файл.json');
  }

  open(): Promise<Readable | null> {
    return Promise.resolve(
      this.present ? Readable.from([Buffer.from('{"a":1}')]) : null,
    );
  }

  remove(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/** Собрать сервис на заданной записи, правах и наличии пользователя. */
function serviceFor(options: {
  row?: Transformation | null;
  allowed?: boolean;
  userExists?: boolean;
  fileInStorage?: boolean;
}): HistoryDownloadService {
  const {
    row = record(),
    allowed = false,
    userExists = true,
    fileInStorage = true,
  } = options;

  const history = {
    findOneBy: (where: { id: string; userId?: string }) =>
      Promise.resolve(
        row &&
          row.id === where.id &&
          (!where.userId || row.userId === where.userId)
          ? row
          : null,
      ),
  } as unknown as Repository<Transformation>;

  return new HistoryDownloadService(
    history,
    new FakeStorage(fileInStorage),
    { can: () => Promise.resolve(allowed) } as unknown as RbacService,
    {
      findById: () =>
        Promise.resolve(userExists ? ({ id: 'x' } as User) : null),
    } as unknown as UsersService,
  );
}

const owner = { id: OWNER } as User;
const stranger = { id: STRANGER } as User;
const admin = { id: ADMIN } as User;

/** Поток целиком в строку. */
async function read(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

describe('Скачивание своего файла', () => {
  it('отдаёт файл владельцу вместе с именем и типом', async () => {
    const result = await serviceFor({}).downloadOwn(owner, ITEM);

    expect(result.filename).toBe('converted.json');
    expect(result.mime).toBe('application/json');
    expect(result.size).toBe(42);
    expect(await read(result.stream)).toBe('{"a":1}');
  });

  it('несуществующая запись — 404', async () => {
    await expect(
      serviceFor({ row: null }).downloadOwn(owner, ITEM),
    ).rejects.toThrow(NotFoundException);
  });

  it('чужая запись — 403', async () => {
    // Номер записи это UUID, перебирать тут нечего: «угадал чужой номер»
    // означает, что он у человека уже был
    await expect(serviceFor({}).downloadOwn(stranger, ITEM)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('запись без файла — 404 с объяснением про save', async () => {
    await expect(
      serviceFor({ row: record({ fileId: null }) }).downloadOwn(owner, ITEM),
    ).rejects.toThrow(/без save/);
  });

  it('истёкший срок — 410, а не 404', async () => {
    // По 410 видно, что ссылка не сломана, а устарела
    await expect(
      serviceFor({
        row: record({ expiresAt: new Date(Date.now() - 1000) }),
      }).downloadOwn(owner, ITEM),
    ).rejects.toThrow(GoneException);
  });

  it('бессрочный файл отдаётся: срока нет — значит не истёк', async () => {
    const result = await serviceFor({
      row: record({ expiresAt: null }),
    }).downloadOwn(owner, ITEM);

    expect(result.filename).toBe('converted.json');
  });

  it('пропавший из хранилища файл — 404, а не 500', async () => {
    await expect(
      serviceFor({ fileInStorage: false }).downloadOwn(owner, ITEM),
    ).rejects.toThrow(NotFoundException);
  });

  it('у старой записи без имени и типа есть разумные умолчания', async () => {
    const result = await serviceFor({
      row: record({ resultName: null, resultMime: null, resultSize: null }),
    }).downloadOwn(owner, ITEM);

    expect(result.filename).toBe('converted.json');
    expect(result.mime).toBe('application/octet-stream');
    expect(result.size).toBeNull();
  });
});

describe('Скачивание файла пользователя администратором', () => {
  it('с правом отдаёт чужой файл', async () => {
    const result = await serviceFor({ allowed: true }).downloadFor(
      admin,
      OWNER,
      ITEM,
    );

    expect(await read(result.stream)).toBe('{"a":1}');
  });

  it('без права — 403 ещё до похода в базу', async () => {
    await expect(
      serviceFor({ allowed: false }).downloadFor(stranger, OWNER, ITEM),
    ).rejects.toThrow(ForbiddenException);
  });

  it('свой файл через это окно доступен и без права', async () => {
    const result = await serviceFor({ allowed: false }).downloadFor(
      owner,
      OWNER,
      ITEM,
    );

    expect(result.filename).toBe('converted.json');
  });

  it('несуществующий пользователь — 404, но только после проверки права', async () => {
    await expect(
      serviceFor({ allowed: true, userExists: false }).downloadFor(
        admin,
        OWNER,
        ITEM,
      ),
    ).rejects.toThrow(NotFoundException);

    // Порядок важен: иначе по разнице между 404 и 403 перебирали бы номера
    await expect(
      serviceFor({ allowed: false, userExists: false }).downloadFor(
        stranger,
        OWNER,
        ITEM,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('чужая запись под другим userId в адресе — 404, а не чужой файл', async () => {
    // Защита от IDOR: запись ищется сразу вместе с владельцем
    await expect(
      serviceFor({ allowed: true }).downloadFor(admin, STRANGER, ITEM),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('Сборка ответа с файлом', () => {
  it('ставит тип, имя вложения и длину', () => {
    const file = toStreamable({
      stream: Readable.from(['x']),
      mime: 'image/png',
      filename: 'converted.png',
      size: 7,
    });

    expect(file.options.type).toBe('image/png');
    expect(file.options.disposition).toBe(
      'attachment; filename="converted.png"',
    );
    expect(file.options.length).toBe(7);
  });

  it('без известного размера длину не выдумывает', () => {
    const file = toStreamable({
      stream: Readable.from(['x']),
      mime: 'image/png',
      filename: 'converted.png',
      size: null,
    });

    expect(file.options.length).toBeUndefined();
  });
});
