import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import type { Env } from '../../config/env.schema.js';
import type { RbacService } from '../../rbac/rbac.service.js';
import { type User, UserStatus } from '../entities/user.entity.js';
import { USERS_ACTIONS } from '../shared/users-permission.js';
import { UserRateLimits } from '../shared/user-rate-limits.service.js';
import { encodeCursor, listUsersSchema } from './dto/list-users.dto.js';
import { UserListService } from './user-list.service.js';

const ACTOR = 'user-actor';

/** Условие WHERE так, как его собрал сервис. */
interface Where {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * Построитель запросов, который ничего не выполняет, а записывает.
 *
 * Проверяем не Postgres, а то, что сервис собрал: не утекают ли лишние
 * колонки, тот ли поиск (по началу строки, а не по подстроке), тот ли
 * порядок и тот ли курсор.
 */
function builder(rows: User[]) {
  const wheres: Where[] = [];
  const order: string[] = [];
  let selected: string[] = [];
  let taken = 0;

  const self = {
    select: (columns: string[]) => {
      selected = columns;
      return self as unknown as SelectQueryBuilder<User>;
    },
    andWhere: (sql: string, params: Record<string, unknown> = {}) => {
      wheres.push({ sql, params });
      return self as unknown as SelectQueryBuilder<User>;
    },
    orderBy: (field: string, direction: string) => {
      order.push(`${field} ${direction}`);
      return self as unknown as SelectQueryBuilder<User>;
    },
    addOrderBy: (field: string, direction: string) => {
      order.push(`${field} ${direction}`);
      return self as unknown as SelectQueryBuilder<User>;
    },
    take: (count: number) => {
      taken = count;
      return self as unknown as SelectQueryBuilder<User>;
    },
    getMany: () => Promise.resolve(rows.slice(0, taken)),
  };

  return {
    wheres,
    order,
    get selected() {
      return selected;
    },
    get taken() {
      return taken;
    },
    queryBuilder: self as unknown as SelectQueryBuilder<User>,
  };
}

/** Пользователь для выборки. */
function person(id: string, overrides: Partial<User> = {}): User {
  return {
    id,
    email: `${id}@example.com`,
    avatarUrl: null,
    status: UserStatus.Active,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLoginAt: null,
    ...overrides,
  } as User;
}

function setup(options: { actions?: string[]; rows?: User[] } = {}) {
  const { actions = [USERS_ACTIONS.List], rows = [person('u1')] } = options;
  const query = builder(rows);

  const users = {
    createQueryBuilder: () => query.queryBuilder,
  } as unknown as Repository<User>;

  return {
    query,
    service: new UserListService(
      users,
      {
        allowedActions: () => Promise.resolve(new Set(actions)),
      } as unknown as RbacService,
      new UserRateLimits({
        get: () => 1_000,
      } as unknown as ConfigService<Env, true>),
    ),
  };
}

const actor = { id: ACTOR } as User;

/** Параметры, прошедшие через схему. */
function query(raw: Record<string, string> = {}) {
  return listUsersSchema.parse(raw);
}

/** Все условия одной строкой. */
function sqlOf(wheres: Where[]): string {
  return wheres.map((where) => where.sql).join(' | ');
}

describe('Доступ к списку', () => {
  it('без права users@list — 403', async () => {
    const { service } = setup({ actions: [] });

    await expect(service.list(actor, query())).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('с правом отдаёт страницу', async () => {
    const { service } = setup();

    const page = await service.list(actor, query());

    expect(page.items).toHaveLength(1);
  });
});

describe('Что попадает в выборку', () => {
  it('колонки перечислены явно, отпечатка пароля среди них нет', async () => {
    const { service, query: q } = setup();

    await service.list(actor, query());

    // Полагаться на select: false у колонки — одна защита; здесь вторая
    expect(q.selected).not.toContain('user.passwordHash');
    expect(q.selected).toContain('user.email');
  });

  it('адрес маскируется без права users@read_email', async () => {
    const { service } = setup({ rows: [person('ivan')] });

    const page = await service.list(actor, query());

    // Список не должен быть способом выгрузить все рабочие адреса разом
    expect(page.items[0]!.email).toBe('iv***@example.com');
  });

  it('с правом на почту адрес виден целиком', async () => {
    const { service } = setup({
      actions: [USERS_ACTIONS.List, USERS_ACTIONS.ReadEmail],
      rows: [person('ivan')],
    });

    const page = await service.list(actor, query());

    expect(page.items[0]!.email).toBe('ivan@example.com');
  });

  it('колонка avatarUrl отдаётся под именем photo из ТЗ', async () => {
    const { service } = setup({ rows: [person('u1', { avatarUrl: 'a.png' })] });

    const page = await service.list(actor, query());

    expect(page.items[0]!.photo).toBe('a.png');
  });
});

describe('Фильтры и поиск', () => {
  it('статус уходит в условие', async () => {
    const { service, query: q } = setup();

    await service.list(actor, query({ status: 'blocked' }));

    expect(sqlOf(q.wheres)).toContain('user.status = :status');
  });

  it('поиск по номеру ищет точное совпадение', async () => {
    const { service, query: q } = setup();
    const uuid = '11111111-2222-4333-8444-555555555555';

    await service.list(actor, query({ q: uuid }));

    expect(sqlOf(q.wheres)).toContain('user.id = :id');
  });

  it('поиск по почте — по началу строки, а не по подстроке', async () => {
    const { service, query: q } = setup();

    await service.list(actor, query({ q: 'Иван' }));

    const search = q.wheres.find((where) => where.sql.includes('ILIKE'));

    // Поиск подстроки индекс использовать не может и читает таблицу целиком
    expect(search!.params.prefix).toBe('иван%');
    expect(String(search!.params.prefix).startsWith('%')).toBe(false);
  });

  it('без поиска лишних условий не добавляется', async () => {
    const { service, query: q } = setup();

    await service.list(actor, query());

    expect(q.wheres).toHaveLength(0);
  });
});

describe('Порядок и страницы', () => {
  it('вторым ключом всегда номер: порядок должен быть однозначным', async () => {
    const { service, query: q } = setup();

    await service.list(actor, query());

    expect(q.order[1]).toBe('user.id DESC');
  });

  it('направление сортировки применяется к обоим ключам', async () => {
    const { service, query: q } = setup();

    await service.list(actor, query({ order: 'asc' }));

    expect(q.order).toEqual(['user.createdAt ASC', 'user.id ASC']);
  });

  it('сортировка по почте идёт по своей колонке', async () => {
    const { service, query: q } = setup();

    await service.list(actor, query({ sort: 'email' }));

    expect(q.order[0]).toBe('user.email DESC');
  });

  it('«ни разу не входил» получает место в порядке, а не выпадает', async () => {
    const { service, query: q } = setup();

    await service.list(actor, query({ sort: 'last_login' }));

    // NULL не больше и не меньше ничего, а курсору нужен полный порядок
    expect(q.order[0]).toContain('COALESCE');
  });

  it('просит на строку больше, чем нужно', async () => {
    const { service, query: q } = setup();

    await service.list(actor, query({ limit: '10' }));

    expect(q.taken).toBe(11);
  });

  it('на последней странице курсора нет', async () => {
    const { service } = setup({ rows: [person('u1')] });

    expect(
      (await service.list(actor, query({ limit: '5' }))).nextCursor,
    ).toBeNull();
  });

  it('при лишней строке отдаёт курсор и ровно limit записей', async () => {
    const { service } = setup({
      rows: [person('a'), person('b'), person('c')],
    });

    const page = await service.list(actor, query({ limit: '2' }));

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
  });

  it('курсор сравнивает пару значений целиком', async () => {
    const { service, query: q } = setup();
    const cursor = encodeCursor({
      value: '2026-01-01T00:00:00.000Z',
      id: 'u1',
    });

    await service.list(actor, query({ cursor }));

    const applied = q.wheres.find((where) => where.sql.includes('user.id)'));

    // Без сравнения пары строки с одинаковым значением поля попадали бы
    // на две страницы сразу
    expect(applied).toBeTruthy();
    expect(applied!.params).toMatchObject({ cursorId: 'u1' });
  });

  it('при сортировке по почте курсор сравнивается как текст', async () => {
    const { service, query: q } = setup();
    const cursor = encodeCursor({ value: 'ivan@example.com', id: 'u1' });

    await service.list(actor, query({ sort: 'email', cursor }));

    expect(sqlOf(q.wheres)).toContain('AS text');
  });

  it('испорченный курсор — 400, а не выборка с начала', async () => {
    const { service } = setup();

    await expect(
      service.list(actor, query({ cursor: 'не курсор' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('курсор указывает на последнюю отданную строку', async () => {
    const { service } = setup({
      rows: [
        person('a', { createdAt: new Date('2026-02-01T00:00:00.000Z') }),
        person('b', { createdAt: new Date('2026-01-15T00:00:00.000Z') }),
        person('c'),
      ],
    });

    const page = await service.list(actor, query({ limit: '2' }));
    const decoded = JSON.parse(
      Buffer.from(page.nextCursor!, 'base64url').toString('utf8'),
    ) as { id: string; value: string };

    expect(decoded.id).toBe('b');
    expect(decoded.value).toBe('2026-01-15T00:00:00.000Z');
  });

  it('курсор по последнему входу понимает «никогда»', async () => {
    const { service } = setup({
      rows: [person('a', { lastLoginAt: null }), person('b'), person('c')],
    });

    const page = await service.list(
      actor,
      query({ sort: 'last_login', limit: '1' }),
    );
    const decoded = JSON.parse(
      Buffer.from(page.nextCursor!, 'base64url').toString('utf8'),
    ) as { value: string };

    expect(decoded.value).toBe('1970-01-01T00:00:00.000Z');
  });
});
