import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import { encodeCursor } from '../common/cursor.js';
import type { RbacService } from '../rbac/rbac.service.js';
import type { User } from '../users/entities/user.entity.js';
import type { UsersService } from '../users/users.service.js';
import { listHistorySchema } from './dto/list-history.dto.js';
import type { Transformation } from './entities/transformation.entity.js';
import { HistoryReadService } from './history-read.service.js';
import { TransformationStatus, TransformationType } from './transformation.js';

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';

/** Условие WHERE так, как его собрал сервис. */
interface Where {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * Построитель запросов, который ничего не выполняет, а записывает.
 *
 * Проверять здесь надо не Postgres, а то, что сервис спросил: те ли
 * условия он собрал, тот ли порядок задал и на сколько строк больше
 * попросил. Настоящая выборка живёт в e2e.
 */
function builder(rows: Transformation[]) {
  const wheres: Where[] = [];
  const order: string[] = [];
  let taken = 0;

  // Без Partial: у orderBy в TypeORM несколько перегрузок, и точное
  // совпадение по каждому методу здесь ничего не проверяет
  const self = {
    select: () => self as unknown as SelectQueryBuilder<Transformation>,
    where: (sql: string, params: Record<string, unknown>) => {
      wheres.push({ sql, params });
      return self as unknown as SelectQueryBuilder<Transformation>;
    },
    andWhere: (sql: string, params: Record<string, unknown>) => {
      wheres.push({ sql, params });
      return self as unknown as SelectQueryBuilder<Transformation>;
    },
    orderBy: (field: string, direction: string) => {
      order.push(`${field} ${direction}`);
      return self as unknown as SelectQueryBuilder<Transformation>;
    },
    addOrderBy: (field: string, direction: string) => {
      order.push(`${field} ${direction}`);
      return self as unknown as SelectQueryBuilder<Transformation>;
    },
    take: (count: number) => {
      taken = count;
      return self as unknown as SelectQueryBuilder<Transformation>;
    },
    getMany: () => Promise.resolve(rows.slice(0, taken)),
  };

  return {
    wheres,
    order,
    get taken() {
      return taken;
    },
    queryBuilder: self as unknown as SelectQueryBuilder<Transformation>,
  };
}

/** Строка истории. */
function row(overrides: Partial<Transformation> = {}): Transformation {
  return {
    id: 'item-1',
    userId: OWNER,
    type: TransformationType.File,
    sourceName: 'секрет.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    status: TransformationStatus.Success,
    statusCode: 200,
    fileSize: 100,
    resultSize: 50,
    error: null,
    durationMs: 5,
    createdAt: new Date('2026-01-01T12:00:00.000Z'),
    fileId: null,
    resultName: null,
    resultMime: null,
    expiresAt: null,
    ...overrides,
  } as Transformation;
}

/** Сервис поверх записывающего построителя. */
function setup(
  options: {
    rows?: Transformation[];
    allowed?: boolean;
    userExists?: boolean;
  } = {},
) {
  const { rows = [row()], allowed = false, userExists = true } = options;
  const query = builder(rows);

  const history = {
    createQueryBuilder: () => query.queryBuilder,
  } as unknown as Repository<Transformation>;

  return {
    query,
    service: new HistoryReadService(
      history,
      { can: () => Promise.resolve(allowed) } as unknown as RbacService,
      {
        findById: () =>
          Promise.resolve(userExists ? ({ id: OWNER } as User) : null),
      } as unknown as UsersService,
    ),
  };
}

/** Параметры запроса, прошедшие через схему. */
function query(raw: Record<string, string> = {}) {
  return listHistorySchema.parse(raw);
}

const owner = { id: OWNER } as User;
const stranger = { id: STRANGER } as User;

/** Все условия одной строкой — по ней удобно искать нужный фильтр. */
function sqlOf(wheres: Where[]): string {
  return wheres.map((where) => where.sql).join(' | ');
}

describe('Своя история', () => {
  it('выбирает только свои записи', async () => {
    const { service, query: q } = setup();

    await service.listOwn(owner, query());

    expect(q.wheres[0]!.sql).toContain('t.userId = :userId');
    expect(q.wheres[0]!.params).toEqual({ userId: OWNER });
  });

  it('новые сверху, вторым ключом — номер записи', async () => {
    const { service, query: q } = setup();

    await service.listOwn(owner, query());

    // Без второго ключа две конвертации в одну миллисекунду разъезжались
    // бы между страницами
    expect(q.order).toEqual(['t.createdAt DESC', 't.id DESC']);
  });

  it('просит на строку больше, чем нужно', async () => {
    const { service, query: q } = setup();

    await service.listOwn(owner, query({ limit: '5' }));

    // Пришла лишняя — значит, впереди есть ещё. Отдельный COUNT дорог
    expect(q.taken).toBe(6);
  });

  it('на последней странице курсора нет', async () => {
    const { service } = setup({ rows: [row()] });

    const page = await service.listOwn(owner, query({ limit: '5' }));

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('при лишней строке отдаёт курсор и ровно limit записей', async () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const { service } = setup({ rows });

    const page = await service.listOwn(owner, query({ limit: '2' }));

    expect(page.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBeTruthy();
  });

  it('пустая история — пустой список без курсора', async () => {
    const { service } = setup({ rows: [] });

    expect(await service.listOwn(owner, query())).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe('Фильтры', () => {
  it('вид, статус и форматы уходят в условия', async () => {
    const { service, query: q } = setup();

    await service.listOwn(
      owner,
      query({
        type: 'image',
        status: 'error',
        sourceFormat: 'png',
        targetFormat: 'jpeg',
      }),
    );

    const sql = sqlOf(q.wheres);

    expect(sql).toContain('t.type = :type');
    expect(sql).toContain('t.status = :status');
    expect(sql).toContain('t.sourceFormat = :sourceFormat');
    expect(sql).toContain('t.targetFormat = :targetFormat');
  });

  it('границы периода включительные с обеих сторон', async () => {
    const { service, query: q } = setup();

    await service.listOwn(
      owner,
      query({ createdAtFrom: '2026-01-01', createdAtTo: '2026-01-31' }),
    );

    const sql = sqlOf(q.wheres);

    // «с 1 по 31 января» естественно читается как «включая 31-е»
    expect(sql).toContain('t.createdAt >= :from');
    expect(sql).toContain('t.createdAt <= :to');
  });

  it('незаданные фильтры условий не добавляют', async () => {
    const { service, query: q } = setup();

    await service.listOwn(owner, query());

    // Только выборка по пользователю
    expect(q.wheres).toHaveLength(1);
  });
});

describe('Курсор', () => {
  it('сравнивает пару (время, номер) целиком', async () => {
    const { service, query: q } = setup();
    const cursor = encodeCursor({
      value: '2026-01-01T12:00:00.000Z',
      id: 'item-1',
    });

    await service.listOwn(owner, query({ cursor }));

    const applied = q.wheres.find((where) =>
      where.sql.includes('createdAt, t.id'),
    );

    expect(applied).toBeTruthy();
    expect(applied!.params).toMatchObject({ cursorId: 'item-1' });
  });

  it('испорченный курсор — 400, а не выборка с начала', async () => {
    const { service } = setup();

    await expect(
      service.listOwn(owner, query({ cursor: 'не курсор' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('курсор указывает на последнюю отданную строку', async () => {
    const rows = [
      row({ id: 'a', createdAt: new Date('2026-01-02T00:00:00.000Z') }),
      row({ id: 'b', createdAt: new Date('2026-01-01T00:00:00.000Z') }),
      row({ id: 'c' }),
    ];
    const { service } = setup({ rows });

    const page = await service.listOwn(owner, query({ limit: '2' }));
    const decoded = JSON.parse(
      Buffer.from(page.nextCursor!, 'base64url').toString('utf8'),
    ) as { id: string; value: string };

    expect(decoded.id).toBe('b');
    expect(decoded.value).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('Что попадает в строку ответа', () => {
  it('имя исходного файла не отдаётся', async () => {
    const { service } = setup({ rows: [row({ sourceName: 'секрет.csv' })] });

    const page = await service.listOwn(owner, query());

    expect(JSON.stringify(page)).not.toContain('секрет');
  });

  it('errorCode есть только у отказов', async () => {
    const { service } = setup({
      rows: [
        row({ status: TransformationStatus.Error, statusCode: 415 }),
        row({ id: 'ok' }),
      ],
    });

    const page = await service.listOwn(owner, query({ limit: '2' }));

    expect(page.items[0]!.errorCode).toBe('415');
    expect('errorCode' in page.items[1]!).toBe(false);
  });

  it('saved показывает, можно ли скачать прямо сейчас', async () => {
    const { service } = setup({
      rows: [
        row({ id: 'нет файла' }),
        row({
          id: 'есть',
          fileId: 'aa/f',
          expiresAt: new Date(Date.now() + 1000),
        }),
        row({
          id: 'истёк',
          fileId: 'aa/f',
          expiresAt: new Date(Date.now() - 1000),
        }),
      ],
    });

    const page = await service.listOwn(owner, query({ limit: '3' }));

    expect(page.items.map((item) => item.saved)).toEqual([false, true, false]);
  });

  it('бессрочный файл считается доступным', async () => {
    const { service } = setup({
      rows: [row({ fileId: 'aa/f', expiresAt: null })],
    });

    const page = await service.listOwn(owner, query());

    expect(page.items[0]!.saved).toBe(true);
    expect(page.items[0]!.expiresAt).toBeNull();
  });

  it('ключ файла наружу не уходит', async () => {
    const { service } = setup({
      rows: [row({ fileId: 'aa/секретный-ключ.json' })],
    });

    const page = await service.listOwn(owner, query());

    expect(JSON.stringify(page)).not.toContain('секретный-ключ');
  });
});

describe('История указанного пользователя', () => {
  it('с правом отдаёт чужую', async () => {
    const { service } = setup({ allowed: true });

    const page = await service.listFor(stranger, OWNER, query());

    expect(page.items).toHaveLength(1);
  });

  it('без права — 403', async () => {
    const { service } = setup({ allowed: false });

    await expect(service.listFor(stranger, OWNER, query())).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('свою можно и без права', async () => {
    const { service } = setup({ allowed: false });

    await expect(service.listFor(owner, OWNER, query())).resolves.toBeTruthy();
  });

  it('несуществующий пользователь — 404, но только после проверки права', async () => {
    const withRight = setup({ allowed: true, userExists: false });

    await expect(
      withRight.service.listFor(stranger, OWNER, query()),
    ).rejects.toThrow(NotFoundException);

    // Иначе по разнице между 404 и 403 перебирали бы номера аккаунтов
    const withoutRight = setup({ allowed: false, userExists: false });

    await expect(
      withoutRight.service.listFor(stranger, OWNER, query()),
    ).rejects.toThrow(ForbiddenException);
  });

  it('выбирает записи указанного пользователя, а не свои', async () => {
    const { service, query: q } = setup({ allowed: true });

    await service.listFor(stranger, OWNER, query());

    expect(q.wheres[0]!.params).toEqual({ userId: OWNER });
  });
});
