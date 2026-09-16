import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Repository } from 'typeorm';
import { Grant } from './entities/grant.entity.js';
import { Permission } from './entities/permission.entity.js';
import { ADMIN_ROLE, Role } from './entities/role.entity.js';
import { GrantsService } from './grants.service.js';
import { PermissionsService } from './permissions.service.js';
import type { RbacAuditService } from './rbac-audit.service.js';
import type { RbacConfigService } from './rbac-config.service.js';
import { RolesService } from './roles.service.js';

const ACTOR = 'actor-1';

/**
 * Таблица в памяти с тем набором методов, которым пользуются сервисы.
 *
 * Поднимать ради проверки правил базу незачем: проверяем мы не то, как
 * Postgres хранит строки, а то, что сервис не даст переименовать admin,
 * удалить занятое разрешение и выдать несуществующее действие.
 */
function table<T extends { id: string } & object>(rows: T[]) {
  let unique: ((row: T, rows: T[]) => boolean) | null = null;

  const repo = {
    find: () => Promise.resolve([...rows]),
    findOneBy: (where: Partial<T> & { id?: unknown }) =>
      Promise.resolve(
        rows.find((row) =>
          Object.entries(where).every(([key, value]) => {
            // Not(id) приходит объектом оператора — для нас это «кроме него»
            if (value && typeof value === 'object' && 'value' in value) {
              return (
                row[key as keyof T] !== (value as { value: unknown }).value
              );
            }

            return row[key as keyof T] === value;
          }),
        ) ?? null,
      ),
    countBy: (where: Partial<T>) =>
      Promise.resolve(
        rows.filter((row) =>
          Object.entries(where).every(
            ([key, value]) => row[key as keyof T] === value,
          ),
        ).length,
      ),
    create: (data: Partial<T>) => {
      const row = { ...data } as T;

      // Номер выдаёт база, если его не прислали. Именно «не прислали», а
      // не «прислали undefined»: сервисы передают dto.id как есть, и
      // затирать им сгенерированный номер нельзя
      row.id ??= `id-${rows.length + 1}`;

      return row;
    },
    save: (row: T) => {
      if (unique?.(row, rows)) {
        return Promise.reject({ code: '23505' });
      }

      const index = rows.findIndex((existing) => existing.id === row.id);

      if (index >= 0) {
        rows[index] = row;
      } else {
        rows.push(row);
      }

      return Promise.resolve(row);
    },
    delete: (where: { id: string }) => {
      const index = rows.findIndex((row) => row.id === where.id);

      if (index >= 0) {
        rows.splice(index, 1);
      }

      return Promise.resolve({ affected: index >= 0 ? 1 : 0 });
    },
  } as unknown as Repository<T>;

  return {
    rows,
    repo,
    /** Объявить, какие строки база считает дубликатами. */
    rejectDuplicates(predicate: (row: T, rows: T[]) => boolean) {
      unique = predicate;
    },
  };
}

/** Журнал и кеш конфигурации: запоминаем, что их вообще дёргали. */
function surroundings() {
  const records: { statusCode: number; reason?: string | null }[] = [];
  let reloads = 0;

  return {
    records,
    // Функция, а не геттер: результат этого объекта разворачивают через
    // spread, и геттер вычислился бы один раз — в момент сборки, когда
    // перечитываний ещё не было
    reloads: () => reloads,
    audit: {
      record: (entry: { statusCode: number; reason?: string | null }) => {
        records.push(entry);
        return Promise.resolve();
      },
    } as unknown as RbacAuditService,
    config: {
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    } as unknown as RbacConfigService,
  };
}

describe('Роли', () => {
  function setup(roles: Role[] = [], grants: Grant[] = []) {
    const rolesTable = table(roles);
    const grantsTable = table(grants);
    const world = surroundings();

    return {
      ...world,
      roles: rolesTable,
      grants: grantsTable,
      service: new RolesService(
        rolesTable.repo,
        grantsTable.repo,
        world.audit,
        world.config,
      ),
    };
  }

  const admin = {
    id: 'r-admin',
    name: ADMIN_ROLE,
    description: null,
  } as unknown as Role;
  const support = {
    id: 'r-support',
    name: 'support',
    description: null,
  } as unknown as Role;

  it('отдаёт список', async () => {
    const { service } = setup([support]);

    expect(await service.findAll()).toEqual([
      { id: 'r-support', name: 'support', description: null },
    ]);
  });

  it('создаёт роль, пишет в журнал и перечитывает правила', async () => {
    const world = setup();

    const created = await world.service.create({ name: 'manager' }, ACTOR);

    expect(created.name).toBe('manager');
    expect(world.records[0]).toMatchObject({ statusCode: 201 });
    // Сценарий из ТЗ: новые права работают со следующего запроса
    expect(world.reloads()).toBe(1);
  });

  it('повторное имя — 409, а не падение базы наружу', async () => {
    const world = setup([support]);

    world.roles.rejectDuplicates((row, rows) =>
      rows.some((existing) => existing.name === row.name),
    );

    await expect(
      world.service.create({ name: 'support' }, ACTOR),
    ).rejects.toThrow(ConflictException);
  });

  it('правит имя и описание', async () => {
    const world = setup([support]);

    const updated = await world.service.update(
      support.id,
      { name: 'helpdesk', description: 'поддержка' },
      ACTOR,
    );

    expect(updated).toMatchObject({
      name: 'helpdesk',
      description: 'поддержка',
    });
  });

  it('несуществующую роль не правит — 404', async () => {
    const world = setup();

    await expect(
      world.service.update('нет', { name: 'x' }, ACTOR),
    ).rejects.toThrow(NotFoundException);
    expect(world.records[0]).toMatchObject({ statusCode: 404 });
  });

  describe('Роль admin защищена', () => {
    it('её нельзя переименовать', async () => {
      const world = setup([admin]);

      await expect(
        world.service.update(admin.id, { name: 'superuser' }, ACTOR),
      ).rejects.toThrow(/нельзя переименовать/);
    });

    it('но описание менять можно', async () => {
      const world = setup([admin]);

      const updated = await world.service.update(
        admin.id,
        { description: 'главный' },
        ACTOR,
      );

      expect(updated.description).toBe('главный');
    });

    it('её нельзя удалить', async () => {
      const world = setup([admin]);

      await expect(
        world.service.remove(admin.id, false, ACTOR),
      ).rejects.toThrow(/удалить нельзя/);
    });
  });

  describe('Удаление роли с назначениями', () => {
    const grant = {
      id: 'g1',
      roleId: support.id,
      permissionId: 'p1',
      actions: [],
    } as unknown as Grant;

    it('без force — 409 с числом назначений', async () => {
      const world = setup([support], [grant]);

      await expect(
        world.service.remove(support.id, false, ACTOR),
      ).rejects.toThrow(/force=true/);
      expect(world.roles.rows).toHaveLength(1);
    });

    it('с force — удаляет', async () => {
      const world = setup([support], [grant]);

      await world.service.remove(support.id, true, ACTOR);

      expect(world.roles.rows).toHaveLength(0);
      expect(world.reloads()).toBe(1);
    });

    it('роль без назначений удаляется и без force', async () => {
      const world = setup([support]);

      await world.service.remove(support.id, false, ACTOR);

      expect(world.roles.rows).toHaveLength(0);
    });
  });
});

describe('Разрешения', () => {
  function setup(permissions: Permission[] = [], grants: Grant[] = []) {
    const permissionsTable = table(permissions);
    const grantsTable = table(grants);
    const world = surroundings();

    return {
      ...world,
      permissions: permissionsTable,
      service: new PermissionsService(
        permissionsTable.repo,
        grantsTable.repo,
        world.audit,
        world.config,
      ),
    };
  }

  const users = {
    id: 'p-users',
    name: 'users',
    actions: ['read', 'list'],
  } as unknown as Permission;

  it('создаёт разрешение с действиями', async () => {
    const world = setup();

    const created = await world.service.create(
      { name: 'files', actions: ['read'] },
      ACTOR,
    );

    expect(created).toMatchObject({ name: 'files', actions: ['read'] });
    expect(world.reloads()).toBe(1);
  });

  it('повторное имя — 409', async () => {
    const world = setup([users]);

    world.permissions.rejectDuplicates((row, rows) =>
      rows.some((existing) => existing.name === row.name),
    );

    await expect(
      world.service.create({ name: 'users', actions: ['read'] }, ACTOR),
    ).rejects.toThrow(ConflictException);
  });

  it('меняет список действий', async () => {
    const world = setup([{ ...users }]);

    const updated = await world.service.update(
      users.id,
      { actions: ['read', 'list', 'update'] },
      ACTOR,
    );

    expect(updated.actions).toEqual(['read', 'list', 'update']);
  });

  it('удаляет свободное разрешение', async () => {
    const world = setup([{ ...users }]);

    await world.service.remove(users.id, ACTOR);

    expect(world.permissions.rows).toHaveLength(0);
  });

  it('выданное ролям разрешение удалить нельзя', async () => {
    // Иначе назначения остались бы висеть в пустоту
    const world = setup(
      [{ ...users }],
      [
        {
          id: 'g1',
          roleId: 'r1',
          permissionId: users.id,
          actions: [],
        } as unknown as Grant,
      ],
    );

    await expect(world.service.remove(users.id, ACTOR)).rejects.toThrow(
      /Сначала удалите назначения/,
    );
  });

  it('несуществующее разрешение — 404', async () => {
    const world = setup();

    await expect(world.service.remove('нет', ACTOR)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('Назначения', () => {
  const role = {
    id: 'r1',
    name: 'support',
    description: null,
  } as unknown as Role;
  const permission = {
    id: 'p1',
    name: 'users',
    actions: ['read', 'list'],
  } as unknown as Permission;

  function setup(grants: Grant[] = []) {
    const rolesTable = table([role]);
    const permissionsTable = table([permission]);
    const grantsTable = table(grants);
    const world = surroundings();

    return {
      ...world,
      grants: grantsTable,
      service: new GrantsService(
        grantsTable.repo,
        rolesTable.repo,
        permissionsTable.repo,
        world.audit,
        world.config,
      ),
    };
  }

  it('создаёт назначение с явными действиями', async () => {
    const world = setup();

    const created = await world.service.create(
      { roleId: role.id, permissionId: permission.id, actions: ['read'] },
      ACTOR,
    );

    expect(created).toMatchObject({ actions: ['read'], allActions: false });
    expect(world.reloads()).toBe(1);
  });

  it('без списка действий выдаёт все действия разрешения', async () => {
    const world = setup();

    const created = await world.service.create(
      { roleId: role.id, permissionId: permission.id },
      ACTOR,
    );

    expect(created).toMatchObject({ actions: [], allActions: true });
  });

  it('действие, которого нет у разрешения, — 400 со списком допустимых', async () => {
    const world = setup();

    await expect(
      world.service.create(
        { roleId: role.id, permissionId: permission.id, actions: ['улететь'] },
        ACTOR,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('несуществующая роль — 404', async () => {
    const world = setup();

    await expect(
      world.service.create(
        { roleId: 'нет', permissionId: permission.id },
        ACTOR,
      ),
    ).rejects.toThrow(/Роль не найдена/);
  });

  it('несуществующее разрешение — 404', async () => {
    const world = setup();

    await expect(
      world.service.create({ roleId: role.id, permissionId: 'нет' }, ACTOR),
    ).rejects.toThrow(/Разрешение не найдено/);
  });

  it('повторное назначение той же пары — 409', async () => {
    const world = setup();

    world.grants.rejectDuplicates((row, rows) =>
      rows.some(
        (existing) =>
          existing.roleId === row.roleId &&
          existing.permissionId === row.permissionId &&
          existing.id !== row.id,
      ),
    );

    await world.service.create(
      { roleId: role.id, permissionId: permission.id },
      ACTOR,
    );

    await expect(
      world.service.create(
        { roleId: role.id, permissionId: permission.id },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('меняет список действий у существующего назначения', async () => {
    const world = setup([
      {
        id: 'g1',
        roleId: role.id,
        permissionId: permission.id,
        actions: ['read'],
      } as unknown as Grant,
    ]);

    const updated = await world.service.update(
      'g1',
      { actions: ['list'] },
      ACTOR,
    );

    expect(updated.actions).toEqual(['list']);
  });

  it('при смене разрешения не тащит за собой прежние действия', async () => {
    // Старые действия в новом разрешении могут и не значиться
    const other = {
      id: 'p2',
      name: 'files',
      actions: ['download'],
    } as unknown as Permission;

    const rolesTable = table([role]);
    const permissionsTable = table([permission, other]);
    const grantsTable = table([
      {
        id: 'g1',
        roleId: role.id,
        permissionId: permission.id,
        actions: ['read'],
      } as unknown as Grant,
    ]);
    const world = surroundings();
    const service = new GrantsService(
      grantsTable.repo,
      rolesTable.repo,
      permissionsTable.repo,
      world.audit,
      world.config,
    );

    const updated = await service.update(
      'g1',
      { permissionId: other.id },
      ACTOR,
    );

    expect(updated).toMatchObject({ permissionId: other.id, allActions: true });
  });

  it('удаляет назначение', async () => {
    const world = setup([
      {
        id: 'g1',
        roleId: role.id,
        permissionId: permission.id,
        actions: [],
      } as unknown as Grant,
    ]);

    await world.service.remove('g1', ACTOR);

    expect(world.grants.rows).toHaveLength(0);
    expect(world.reloads()).toBe(1);
  });

  it('несуществующее назначение — 404', async () => {
    const world = setup();

    await expect(world.service.remove('нет', ACTOR)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('отдаёт список назначений', async () => {
    const world = setup([
      {
        id: 'g1',
        roleId: role.id,
        permissionId: permission.id,
        actions: [],
      } as unknown as Grant,
    ]);

    expect(await world.service.findAll()).toEqual([
      {
        id: 'g1',
        roleId: role.id,
        permissionId: permission.id,
        actions: [],
        allActions: true,
      },
    ]);
  });
});
