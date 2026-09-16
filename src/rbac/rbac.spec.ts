import { ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { Grant } from './entities/grant.entity.js';
import type { Permission } from './entities/permission.entity.js';
import { ADMIN_ROLE, type Role } from './entities/role.entity.js';
import type { RbacAuditService } from './rbac-audit.service.js';
import { type RbacConfig, RbacConfigService } from './rbac-config.service.js';
import {
  parsePermissionRef,
  type RbacSubject,
  RbacService,
} from './rbac.service.js';

/** Номера ролей: в конфигурации назначения ищутся именно по ним. */
const SUPPORT = 'role-support';
const MANAGER = 'role-manager';
const ADMIN = 'role-admin';

/**
 * Готовая конфигурация вместо базы.
 *
 * Проверка прав в базу не ходит — она работает со снимком в памяти,
 * который собирает RbacConfigService. Поэтому её можно проверять на
 * рукописном снимке, и это честно: ровно такой объект и приходит в бою.
 */
const CONFIG: RbacConfig = {
  permissions: new Map([
    ['users', { id: 'p-users', actions: new Set(['read', 'list', 'update']) }],
    ['transformations', { id: 'p-tr', actions: new Set(['history_admin']) }],
  ]),
  // Тип указан явно: у значений разный вид — null («все действия») и
  // множество, — и вывести общий тип из литерала не получится
  grants: new Map<string, Map<string, Set<string> | null>>([
    [ADMIN, new Map([['users', null]])],
    [SUPPORT, new Map([['users', new Set(['read', 'list'])]])],
    [MANAGER, new Map([['transformations', new Set(['history_admin'])]])],
  ]),
  roleNames: new Map([
    [ADMIN, ADMIN_ROLE],
    [SUPPORT, 'support'],
    [MANAGER, 'manager'],
  ]),
  loadedAt: new Date(),
};

/** Пользователь с набором ролей. */
function subject(...roles: [string, string][]): RbacSubject {
  return {
    id: 'user-1',
    roles: roles.map(([id, name]) => ({ id, name })),
  };
}

const support = subject([SUPPORT, 'support']);
const manager = subject([MANAGER, 'manager']);
const admin = subject([ADMIN, ADMIN_ROLE]);
const nobody = subject();

let rbac: RbacService;

beforeEach(() => {
  rbac = new RbacService({
    getConfig: () => Promise.resolve(CONFIG),
  } as unknown as RbacConfigService);
});

describe('Запись «ресурс@действие»', () => {
  it('разбирается на две части', () => {
    expect(parsePermissionRef('users@read')).toEqual({
      permission: 'users',
      action: 'read',
    });
  });

  it('разрешает собаку внутри действия', () => {
    expect(parsePermissionRef('users@read@extra')).toEqual({
      permission: 'users',
      action: 'read@extra',
    });
  });

  describe('Падает сразу и громко', () => {
    // Это опечатка программиста в наклейке, а не ошибка клиента: заметить
    // её надо на первом же запросе, а не однажды в логах
    it.each(['users', '@read', 'users@', ''])('на записи «%s»', (reference) => {
      expect(() => parsePermissionRef(reference)).toThrow(
        /Некорректная запись разрешения/,
      );
    });
  });
});

describe('Проверка доступа', () => {
  it('роль admin узнаётся по названию', () => {
    expect(rbac.isAdmin(admin)).toBe(true);
    expect(rbac.isAdmin(support)).toBe(false);
    expect(rbac.isAdmin(nobody)).toBe(false);
  });

  it('пускает, когда действие выдано ролью', async () => {
    expect(await rbac.can(support, 'users', 'read')).toBe(true);
    expect(await rbac.can(support, 'users', 'list')).toBe(true);
  });

  it('не пускает на действие, которого роли не выдали', async () => {
    expect(await rbac.can(support, 'users', 'update')).toBe(false);
  });

  it('назначение без списка действий даёт все действия разрешения', async () => {
    for (const action of ['read', 'list', 'update']) {
      expect(await rbac.can(admin, 'users', action)).toBe(true);
    }
  });

  it('но не даёт действий, которых у разрешения нет', async () => {
    // Выдали «все действия» — значит все объявленные, а не любые придуманные
    expect(await rbac.can(admin, 'users', 'delete')).toBe(false);
  });

  it('без ролей не пускает никуда', async () => {
    expect(await rbac.can(nobody, 'users', 'read')).toBe(false);
  });

  it('хватает одной подходящей роли из нескольких', async () => {
    const both = subject([SUPPORT, 'support'], [MANAGER, 'manager']);

    expect(await rbac.can(both, 'users', 'read')).toBe(true);
    expect(await rbac.can(both, 'transformations', 'history_admin')).toBe(true);
  });

  it('незнакомое разрешение — отказ, а не пропуск', async () => {
    // Молча пропускать разрешение, которого нет в конфигурации, — дыра:
    // опечатка в наклейке открывала бы окно всем подряд
    expect(await rbac.can(admin, 'выдуманное', 'read')).toBe(false);
  });

  it('действие, не объявленное у разрешения, недействительно', async () => {
    expect(await rbac.can(support, 'users', 'сделать-всё')).toBe(false);
  });

  it('роль без этого разрешения не мешает смотреть дальше', async () => {
    expect(await rbac.can(manager, 'users', 'read')).toBe(false);
  });
});

describe('Все доступные действия разом', () => {
  it('отдаёт то, что выдано роли', async () => {
    expect([...(await rbac.allowedActions(support, 'users'))].sort()).toEqual([
      'list',
      'read',
    ]);
  });

  it('для «всех действий» отдаёт объявленные у разрешения', async () => {
    expect([...(await rbac.allowedActions(admin, 'users'))].sort()).toEqual([
      'list',
      'read',
      'update',
    ]);
  });

  it('пусто, если ролей нет или разрешение незнакомо', async () => {
    expect((await rbac.allowedActions(nobody, 'users')).size).toBe(0);
    expect((await rbac.allowedActions(admin, 'выдуманное')).size).toBe(0);
  });

  it('не отдаёт действие, которое выдали роли, но убрали из разрешения', async () => {
    const stale: RbacConfig = {
      ...CONFIG,
      grants: new Map<string, Map<string, Set<string> | null>>([
        [SUPPORT, new Map([['users', new Set(['read', 'улетело'])]])],
      ]),
    };
    const service = new RbacService({
      getConfig: () => Promise.resolve(stale),
    } as unknown as RbacConfigService);

    expect([...(await service.allowedActions(support, 'users'))]).toEqual([
      'read',
    ]);
  });
});

describe('Короткие формы', () => {
  it('check пропускает разрешённое и бросает 403 на остальное', async () => {
    await expect(rbac.check(support, 'users', 'read')).resolves.toBeUndefined();
    await expect(rbac.check(support, 'users', 'update')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('canRef понимает запись «ресурс@действие»', async () => {
    expect(await rbac.canRef(support, 'users@read')).toBe(true);
    expect(await rbac.canRef(support, 'users@update')).toBe(false);
  });
});

describe('Сборка конфигурации из базы', () => {
  /** Репозиторий, отдающий заранее заданные строки. */
  function repo<T extends object>(rows: T[]): Repository<T> {
    return { find: () => Promise.resolve(rows) } as unknown as Repository<T>;
  }

  const audit = {
    record: () => Promise.resolve(),
  } as unknown as RbacAuditService;

  const roles = [
    { id: ADMIN, name: ADMIN_ROLE },
    { id: SUPPORT, name: 'support' },
  ] as unknown as Role[];

  const permissions = [
    { id: 'p-users', name: 'users', actions: ['read', 'list'] },
  ] as unknown as Permission[];

  /** Собрать сервис с заданными назначениями. */
  function serviceWith(grants: Grant[]): RbacConfigService {
    return new RbacConfigService(
      repo(roles),
      repo(permissions),
      repo(grants),
      audit,
    );
  }

  it('переводит номера разрешений в названия', async () => {
    const service = serviceWith([
      { id: 'g1', roleId: SUPPORT, permissionId: 'p-users', actions: ['read'] },
    ] as unknown as Grant[]);

    const config = await service.getConfig();

    expect(config.grants.get(SUPPORT)?.get('users')).toEqual(new Set(['read']));
    expect(config.permissions.get('users')?.actions).toEqual(
      new Set(['read', 'list']),
    );
    expect(config.roleNames.get(ADMIN)).toBe(ADMIN_ROLE);
  });

  it('пустой список действий превращает в «все действия»', async () => {
    const service = serviceWith([
      { id: 'g1', roleId: ADMIN, permissionId: 'p-users', actions: [] },
    ] as unknown as Grant[]);

    expect(
      (await service.getConfig()).grants.get(ADMIN)?.get('users'),
    ).toBeNull();
  });

  it('пропускает назначение в пустоту, а не роняет загрузку', async () => {
    // Внешний ключ такого не допустит, но строку могли удалить в обход
    // приложения. Одно потерянное назначение лучше, чем мёртвый RBAC
    const service = serviceWith([
      { id: 'g1', roleId: SUPPORT, permissionId: 'нет такого', actions: [] },
      { id: 'g2', roleId: SUPPORT, permissionId: 'p-users', actions: ['read'] },
    ] as unknown as Grant[]);

    const config = await service.getConfig();

    expect(config.grants.get(SUPPORT)?.get('users')).toEqual(new Set(['read']));
    expect(config.grants.get(SUPPORT)?.size).toBe(1);
  });

  it('второй запрос берёт конфигурацию из кеша', async () => {
    let loads = 0;
    const counting = {
      find: () => {
        loads += 1;
        return Promise.resolve(permissions);
      },
    } as unknown as Repository<Permission>;

    const service = new RbacConfigService(
      repo(roles),
      counting,
      repo([]),
      audit,
    );

    await service.getConfig();
    await service.getConfig();

    // Правила меняются раз в месяц, а проверка идёт на каждом запросе
    expect(loads).toBe(1);
  });

  it('одновременные запросы ждут одной загрузки, а не десяти', async () => {
    let loads = 0;
    const slow = {
      find: async () => {
        loads += 1;
        await Promise.resolve();
        return permissions;
      },
    } as unknown as Repository<Permission>;

    const service = new RbacConfigService(repo(roles), slow, repo([]), audit);

    await Promise.all([
      service.getConfig(),
      service.getConfig(),
      service.getConfig(),
    ]);

    expect(loads).toBe(1);
  });

  it('сброс кеша заставляет перечитать правила', async () => {
    let loads = 0;
    const counting = {
      find: () => {
        loads += 1;
        return Promise.resolve(permissions);
      },
    } as unknown as Repository<Permission>;

    const service = new RbacConfigService(
      repo(roles),
      counting,
      repo([]),
      audit,
    );

    await service.getConfig();
    service.invalidate();
    await service.getConfig();

    expect(loads).toBe(2);
  });

  it('до первой загрузки времени загрузки нет, после — есть', async () => {
    const service = serviceWith([]);

    expect(service.loadedAt).toBeNull();
    await service.getConfig();
    expect(service.loadedAt).toBeInstanceOf(Date);
  });

  it('reload перечитывает правила и пишет в журнал', async () => {
    const records: unknown[] = [];
    const service = new RbacConfigService(
      repo(roles),
      repo(permissions),
      repo([]),
      {
        record: (entry: unknown) => {
          records.push(entry);
          return Promise.resolve();
        },
      } as unknown as RbacAuditService,
    );

    await service.reload('actor-1');

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      actorUserId: 'actor-1',
      statusCode: 200,
    });
  });

  it('загрузка при старте приложения происходит сама', async () => {
    const service = serviceWith([]);

    await service.onModuleInit();

    expect(service.loadedAt).not.toBeNull();
  });
});
