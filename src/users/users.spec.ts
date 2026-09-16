import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import type { Repository } from 'typeorm';
import type { RbacService } from '../rbac/rbac.service.js';
import { type User, UserStatus } from './entities/user.entity.js';
import { ProfileReadService } from './profile/profile-read.service.js';
import { ProfileWriteService } from './profile/profile-write.service.js';
import { USERS_ACTIONS } from './shared/users-permission.js';
import { UserRateLimits } from './shared/user-rate-limits.service.js';
import { UsersService } from './users.service.js';

const VIEWER = 'user-viewer';
const TARGET = 'user-target';

/** Пользователь со всеми полями профиля. */
function person(id: string, overrides: Partial<User> = {}): User {
  return {
    id,
    email: `${id}@example.com`,
    avatarUrl: 'photo.png',
    status: UserStatus.Active,
    emailVerifiedAt: new Date('2025-01-01'),
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-02'),
    roles: [],
    ...overrides,
  } as User;
}

/** Ограничители с щедрыми лимитами: считаем их отдельно. */
function limits(overrides: Record<string, number> = {}): UserRateLimits {
  return new UserRateLimits({
    get: (key: string) => overrides[key] ?? 1_000,
  } as unknown as ConfigService<Env, true>);
}

/** Сервис пользователей поверх таблицы в памяти. */
function usersOver(rows: User[]) {
  const repo = {
    findOne: (options: { where: Partial<User> }) =>
      Promise.resolve(
        rows.find((row) =>
          Object.entries(options.where).every(
            ([key, value]) => row[key as keyof User] === value,
          ),
        ) ?? null,
      ),
    update: (where: { id: string }, changes: Partial<User>) => {
      const row = rows.find((candidate) => candidate.id === where.id);

      if (!row) {
        return Promise.resolve({ affected: 0 });
      }

      if (
        changes.email &&
        rows.some(
          (other) => other.id !== where.id && other.email === changes.email,
        )
      ) {
        return Promise.reject({ code: '23505' });
      }

      Object.assign(row, changes);
      return Promise.resolve({ affected: 1 });
    },
    delete: (where: { id: string }) => {
      const index = rows.findIndex((row) => row.id === where.id);

      if (index >= 0) {
        rows.splice(index, 1);
      }

      return Promise.resolve({ affected: index >= 0 ? 1 : 0 });
    },
    create: (data: Partial<User>) => ({ id: 'new', ...data }) as User,
    save: (row: User) => {
      rows.push(row);
      return Promise.resolve(row);
    },
  } as unknown as Repository<User>;

  return { rows, service: new UsersService(repo) };
}

/** Права: заданный набор действий над разрешением users. */
function rbacWith(actions: string[]): RbacService {
  return {
    allowedActions: () => Promise.resolve(new Set(actions)),
  } as unknown as RbacService;
}

describe('Сервис пользователей', () => {
  it('находит по номеру и по почте', async () => {
    const { service } = usersOver([person(TARGET)]);

    expect((await service.findById(TARGET))?.id).toBe(TARGET);
    expect((await service.findByEmail(`${TARGET}@example.com`))?.id).toBe(
      TARGET,
    );
    expect(await service.findById('нет')).toBeNull();
  });

  it('отдаёт отпечаток пароля только по отдельной просьбе', async () => {
    const { service } = usersOver([person(TARGET)]);

    // Колонка скрыта от обычных выборок, поэтому метод отдельный
    expect(
      (await service.findByEmailWithPassword(`${TARGET}@example.com`))?.id,
    ).toBe(TARGET);
  });

  it('findByIdOrFail бросает 404 вместо null', async () => {
    const { service } = usersOver([]);

    await expect(service.findByIdOrFail('нет')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('подтверждение почты делает аккаунт рабочим', async () => {
    const pending = person(TARGET, {
      status: UserStatus.PendingVerification,
      emailVerifiedAt: null,
    });
    const { service } = usersOver([pending]);

    const updated = await service.markEmailVerified(TARGET);

    expect(updated.status).toBe(UserStatus.Active);
    expect(updated.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('правка профиля отвечает числом изменённых строк', async () => {
    const { service } = usersOver([person(TARGET)]);

    expect(await service.updateProfile(TARGET, { avatarUrl: 'new.png' })).toBe(
      1,
    );
    expect(await service.updateProfile('нет', { avatarUrl: 'x' })).toBe(0);
  });

  it('отмечает вход', async () => {
    const rows = [person(TARGET, { lastLoginAt: null } as Partial<User>)];
    const { service } = usersOver(rows);

    await service.markLoggedIn(TARGET);

    expect(rows[0]!.lastLoginAt).toBeInstanceOf(Date);
  });

  it('удаляет и сообщает, было ли что удалять', async () => {
    const { service, rows } = usersOver([person(TARGET)]);

    expect(await service.deleteById(TARGET)).toBe(1);
    expect(rows).toHaveLength(0);
    expect(await service.deleteById(TARGET)).toBe(0);
  });

  it('создаёт пользователя с готовым отпечатком пароля', async () => {
    const { service, rows } = usersOver([]);

    const created = await service.create({
      email: 'a@b.com',
      passwordHash: 'отпечаток',
      status: UserStatus.PendingVerification,
      emailVerifiedAt: null,
    });

    expect(created.email).toBe('a@b.com');
    expect(rows).toHaveLength(1);
  });
});

describe('Просмотр профиля', () => {
  function setup(actions: string[], rows: User[] = [person(TARGET)]) {
    const users = usersOver(rows);

    return new ProfileReadService(users.service, rbacWith(actions), limits());
  }

  it('свой профиль виден целиком и без прав', async () => {
    const viewer = person(VIEWER);
    const service = setup([]);

    const view = await service.view(viewer, VIEWER);

    expect(view.email).toBe(viewer.email);
    expect(view.updatedAt).toBeTruthy();
  });

  it('чужой без права users.read — 403', async () => {
    await expect(setup([]).view(person(VIEWER), TARGET)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('с базовым правом видно всё, кроме почты и отметок', async () => {
    const view = await setup([USERS_ACTIONS.Read]).view(person(VIEWER), TARGET);

    expect(Object.keys(view).sort()).toEqual([
      'createdAt',
      'id',
      'photo',
      'status',
    ]);
  });

  it('право на почту добавляет её', async () => {
    const view = await setup([
      USERS_ACTIONS.Read,
      USERS_ACTIONS.ReadEmail,
    ]).view(person(VIEWER), TARGET);

    expect(view.email).toBe(`${TARGET}@example.com`);
  });

  it('несуществующий пользователь — 404', async () => {
    await expect(
      setup([USERS_ACTIONS.Read], []).view(person(VIEWER), TARGET),
    ).rejects.toThrow(NotFoundException);
  });

  it('просмотры чужих профилей ограничены по числу', async () => {
    // Защита от выкачивания базы пользователей
    const users = usersOver([person(TARGET)]);
    const service = new ProfileReadService(
      users.service,
      rbacWith([USERS_ACTIONS.Read]),
      limits({ PROFILE_FOREIGN_READ_LIMIT: 2 }),
    );
    const viewer = person(VIEWER);

    await service.view(viewer, TARGET);
    await service.view(viewer, TARGET);

    await expect(service.view(viewer, TARGET)).rejects.toThrow(HttpException);
  });

  it('свой профиль под ограничитель не попадает', async () => {
    const users = usersOver([]);
    const service = new ProfileReadService(
      users.service,
      rbacWith([]),
      limits({ PROFILE_FOREIGN_READ_LIMIT: 1 }),
    );
    const viewer = person(VIEWER);

    await service.view(viewer, VIEWER);
    await service.view(viewer, VIEWER);

    await expect(service.view(viewer, VIEWER)).resolves.toBeTruthy();
  });
});

describe('Изменение профиля', () => {
  function setup(actions: string[], rows: User[]) {
    const users = usersOver(rows);

    return {
      rows: users.rows,
      service: new ProfileWriteService(
        users.service,
        rbacWith(actions),
        limits(),
      ),
    };
  }

  it('себе можно менять фото', async () => {
    const me = person(VIEWER);
    const { service, rows } = setup([], [me]);

    await service.update(me, VIEWER, { photo: 'new.png' });

    expect(rows[0]!.avatarUrl).toBe('new.png');
  });

  it('себе нельзя менять статус', async () => {
    const me = person(VIEWER);
    const { service } = setup([], [me]);

    await expect(
      service.update(me, VIEWER, { status: UserStatus.Active }),
    ).rejects.toThrow(/Нет прав на изменение полей/);
  });

  it('себе нельзя менять почту напрямую — и сказано почему', async () => {
    const me = person(VIEWER);
    const { service } = setup([], [me]);

    await expect(
      service.update(me, VIEWER, { email: 'new@b.com' }),
    ).rejects.toThrow(/запрос на смену с подтверждением/);
  });

  it('чужой профиль без права users.update — 403', async () => {
    const { service } = setup([USERS_ACTIONS.Read], [person(TARGET)]);

    await expect(
      service.update(person(VIEWER), TARGET, { photo: 'x.png' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('с правом чужой профиль меняется', async () => {
    const { service, rows } = setup(
      [USERS_ACTIONS.Read, USERS_ACTIONS.Update],
      [person(TARGET)],
    );

    await service.update(person(VIEWER), TARGET, {
      status: UserStatus.Blocked,
    });

    expect(rows[0]!.status).toBe(UserStatus.Blocked);
  });

  it('несуществующий пользователь — 404', async () => {
    const { service } = setup([USERS_ACTIONS.Update], []);

    await expect(
      service.update(person(VIEWER), TARGET, { photo: 'x.png' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('занятая почта — 409, а не ошибка базы наружу', async () => {
    const { service } = setup(
      [USERS_ACTIONS.Read, USERS_ACTIONS.Update, USERS_ACTIONS.ReadEmail],
      [person(TARGET), person('other')],
    );

    await expect(
      service.update(person(VIEWER), TARGET, { email: 'other@example.com' }),
    ).rejects.toThrow(ConflictException);
  });

  it('после правки себе возвращается свежий профиль', async () => {
    const me = person(VIEWER);
    const { service } = setup([], [me]);

    const answer = await service.update(me, VIEWER, { photo: 'new.png' });

    expect(answer).toMatchObject({ photo: 'new.png' });
  });

  it('без права читать возвращается только список изменённых полей', async () => {
    // Изменить профиль можно, а читать его — нет: тогда и показывать нечего
    const { service } = setup([USERS_ACTIONS.Update], [person(TARGET)]);

    const answer = await service.update(person(VIEWER), TARGET, {
      photo: 'new.png',
    });

    expect(answer).toEqual({ updated: ['photo'] });
  });

  it('число правок ограничено', async () => {
    const me = person(VIEWER);
    const users = usersOver([me]);
    const service = new ProfileWriteService(
      users.service,
      rbacWith([]),
      limits({ PROFILE_WRITE_LIMIT: 1 }),
    );

    await service.update(me, VIEWER, { photo: 'a.png' });

    await expect(
      service.update(me, VIEWER, { photo: 'b.png' }),
    ).rejects.toThrow(HttpException);
  });
});

describe('Ограничители по аккаунту', () => {
  it('у каждого сценария свой счётчик', () => {
    const rates = limits({ PROFILE_WRITE_LIMIT: 1, EMAIL_CHANGE_LIMIT: 1 });

    rates.hitProfileWrite('u1');

    // Исчерпанный лимит правок не должен закрывать смену почты
    expect(() => rates.hitEmailChange('u1')).not.toThrow();
    expect(() => rates.hitProfileWrite('u1')).toThrow(HttpException);
  });

  it('сообщения объясняют, что именно исчерпано', () => {
    const rates = limits({ DELETION_LIMIT: 1 });

    rates.hitDeletion('u1');

    expect(() => rates.hitDeletion('u1')).toThrow(/удаление/);
  });

  it('просмотр чужих профилей и список пользователей считаются отдельно', () => {
    const rates = limits({
      PROFILE_FOREIGN_READ_LIMIT: 1,
      USER_LIST_LIMIT: 1,
    });

    rates.hitForeignRead('u1');
    rates.hitUserList('u1');

    expect(() => rates.hitForeignRead('u1')).toThrow(HttpException);
    expect(() => rates.hitUserList('u1')).toThrow(HttpException);
  });
});
