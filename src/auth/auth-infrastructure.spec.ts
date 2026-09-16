import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { Repository } from 'typeorm';
import { MailService } from '../mail/mail.service.js';
import { magicLinkLetter, otpLetter } from '../mail/mail.templates.js';
import { RbacAuditService } from '../rbac/rbac-audit.service.js';
import { AdminGuard } from '../rbac/guards/admin.guard.js';
import { PermissionsGuard } from '../rbac/guards/permissions.guard.js';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator.js';
import type { RbacService } from '../rbac/rbac.service.js';
import { AuthSettingsService } from '../settings/auth-settings.service.js';
import type { AuthSettings } from '../settings/entities/auth-settings.entity.js';
import { type User, UserStatus } from '../users/entities/user.entity.js';
import type { UsersService } from '../users/users.service.js';
import { AuditService } from './audit.service.js';
import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from './cookies.js';
import type { AuthAuditLog } from './entities/auth-audit-log.entity.js';
import { AuthAuditEvent } from './entities/auth-audit-log.entity.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

/** Настройки токенов и паролей, как их отдал бы ConfigService. */
const ENV: Record<string, string | number> = {
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  // Минимум из допустимых: bcrypt намеренно медленный, и в тестах это
  // единственное место, где ожидание заметно
  BCRYPT_ROUNDS: 4,
};

function config(
  overrides: Record<string, unknown> = {},
): ConfigService<Env, true> {
  return {
    get: (key: string) => overrides[key] ?? ENV[key],
  } as unknown as ConfigService<Env, true>;
}

describe('Токены входа', () => {
  const tokens = new TokenService(new JwtService(), config());

  it('выдаёт пару разных токенов', async () => {
    const pair = await tokens.issuePair({ sub: 'u1', email: 'a@b.com' });

    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();
    // Разные секреты и разные jti: иначе один токен годился бы вместо другого
    expect(pair.accessToken).not.toBe(pair.refreshToken);
  });

  it('в токене лежит тот, кому его выдали', async () => {
    const pair = await tokens.issuePair({ sub: 'u1', email: 'a@b.com' });
    const payload = tokens.verifyAccess(pair.accessToken);

    expect(payload.sub).toBe('u1');
    expect(payload.email).toBe('a@b.com');
    expect(payload.jti).toBeTruthy();
  });

  it('каждая выдача даёт новый номер токена', async () => {
    const first = await tokens.issuePair({ sub: 'u1', email: 'a@b.com' });
    const second = await tokens.issuePair({ sub: 'u1', email: 'a@b.com' });

    expect(tokens.verifyAccess(first.accessToken).jti).not.toBe(
      tokens.verifyAccess(second.accessToken).jti,
    );
  });

  it('refresh-токен не принимается вместо access и наоборот', async () => {
    const pair = await tokens.issuePair({ sub: 'u1', email: 'a@b.com' });

    // Секреты разные именно для этого: украденный refresh не откроет окна
    expect(() => tokens.verifyAccess(pair.refreshToken)).toThrow(
      UnauthorizedException,
    );
    expect(() => tokens.verifyRefresh(pair.accessToken)).toThrow(
      UnauthorizedException,
    );
  });

  it('refresh проверяется своим секретом и проходит', async () => {
    const pair = await tokens.issuePair({ sub: 'u1', email: 'a@b.com' });

    expect(tokens.verifyRefresh(pair.refreshToken).sub).toBe('u1');
  });

  it('подделку и мусор отвергает 401, а не внутренней ошибкой', () => {
    expect(() => tokens.verifyAccess('не токен')).toThrow(
      UnauthorizedException,
    );
    expect(() => tokens.verifyAccess('')).toThrow(UnauthorizedException);
  });

  it('токен, подписанный чужим секретом, не проходит', async () => {
    const stranger = new TokenService(
      new JwtService(),
      config({ JWT_ACCESS_SECRET: 'z'.repeat(32) }),
    );
    const foreign = await stranger.issuePair({ sub: 'u1', email: 'a@b.com' });

    expect(() => tokens.verifyAccess(foreign.accessToken)).toThrow(
      UnauthorizedException,
    );
  });
});

describe('Пароли', () => {
  const passwords = new PasswordService(config());

  it('отпечаток не совпадает с паролем и не повторяется', async () => {
    const first = await passwords.hash('secret123');
    const second = await passwords.hash('secret123');

    expect(first).not.toBe('secret123');
    // Соль у каждого своя: одинаковые пароли дают разные отпечатки
    expect(first).not.toBe(second);
  });

  it('проверяет пароль по отпечатку', async () => {
    const hash = await passwords.hash('secret123');

    expect(await passwords.verify('secret123', hash)).toBe(true);
    expect(await passwords.verify('secret124', hash)).toBe(false);
  });
});

describe('Cookies с токенами', () => {
  /** Поддельный ответ Express, запоминающий поставленные cookies. */
  function response() {
    const set: Record<
      string,
      { value: string; options: Record<string, unknown> }
    > = {};
    const cleared: string[] = [];

    return {
      set,
      cleared,
      express: {
        cookie: (
          name: string,
          value: string,
          options: Record<string, unknown>,
        ) => {
          set[name] = { value, options };
        },
        clearCookie: (name: string) => cleared.push(name),
      } as unknown as Response,
    };
  }

  const settings = { secure: true, sameSite: 'lax' as const };

  it('кладёт оба токена', () => {
    const res = response();

    setAuthCookies(
      res.express,
      { accessToken: 'A', refreshToken: 'R' },
      settings,
    );

    expect(res.set[ACCESS_COOKIE]!.value).toBe('A');
    expect(res.set[REFRESH_COOKIE]!.value).toBe('R');
  });

  it('закрывает cookie от скриптов на странице', () => {
    const res = response();

    setAuthCookies(
      res.express,
      { accessToken: 'A', refreshToken: 'R' },
      settings,
    );

    // httpOnly — главная защита: чужой скрипт не украдёт токен
    expect(res.set[ACCESS_COOKIE]!.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('refresh живёт дольше access', () => {
    const res = response();

    setAuthCookies(
      res.express,
      { accessToken: 'A', refreshToken: 'R' },
      settings,
    );

    expect(Number(res.set[REFRESH_COOKIE]!.options.maxAge)).toBeGreaterThan(
      Number(res.set[ACCESS_COOKIE]!.options.maxAge),
    );
  });

  it('выход убирает обе cookie', () => {
    const res = response();

    clearAuthCookies(res.express, settings);

    expect(res.cleared.sort()).toEqual([ACCESS_COOKIE, REFRESH_COOKIE].sort());
  });
});

describe('Охранник закрытых окон', () => {
  const tokens = new TokenService(new JwtService(), config());

  /** Пользователь, которого «найдёт» сервис. */
  function usersReturning(user: User | null): UsersService {
    return {
      findByIdWithRoles: () => Promise.resolve(user),
    } as unknown as UsersService;
  }

  /** Контекст с заданными cookies. */
  function contextWith(cookies: Record<string, string>): ExecutionContext {
    const request = { cookies, method: 'GET', url: '/api/me' };

    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  const active = {
    id: 'u1',
    email: 'a@b.com',
    status: UserStatus.Active,
  } as User;

  it('пускает с годным токеном и кладёт пользователя в запрос', async () => {
    const pair = await tokens.issuePair({ sub: 'u1', email: 'a@b.com' });
    const guard = new JwtAuthGuard(tokens, usersReturning(active));
    const context = contextWith({ [ACCESS_COOKIE]: pair.accessToken });

    expect(await guard.canActivate(context)).toBe(true);
    expect((context.switchToHttp().getRequest() as { user?: User }).user).toBe(
      active,
    );
  });

  it('без cookie — 401', async () => {
    const guard = new JwtAuthGuard(tokens, usersReturning(active));

    await expect(guard.canActivate(contextWith({}))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('токен есть, а пользователя нет — 401', async () => {
    // Токен мог быть выдан удалённому аккаунту
    const pair = await tokens.issuePair({ sub: 'u1', email: 'a@b.com' });
    const guard = new JwtAuthGuard(tokens, usersReturning(null));

    await expect(
      guard.canActivate(contextWith({ [ACCESS_COOKIE]: pair.accessToken })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('заблокированного не пускает, даже если токен ещё живой', async () => {
    const pair = await tokens.issuePair({ sub: 'u1', email: 'a@b.com' });
    const blocked = { ...active, status: UserStatus.Blocked } as User;
    const guard = new JwtAuthGuard(tokens, usersReturning(blocked));

    await expect(
      guard.canActivate(contextWith({ [ACCESS_COOKIE]: pair.accessToken })),
    ).rejects.toThrow(/заблокирован/);
  });
});

describe('Охранник прав', () => {
  class Handlers {
    @RequirePermission('users@read')
    guarded(): void {}

    open(): void {}
  }

  const handlers = new Handlers();
  const audit = {
    record: () => Promise.resolve(),
  } as unknown as RbacAuditService;

  function contextFor(handler: () => void, user?: User): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user, method: 'GET', url: '/users/1' }),
      }),
      getHandler: () => handler,
      getClass: () => Handlers,
    } as unknown as ExecutionContext;
  }

  function guardWith(allowed: boolean): PermissionsGuard {
    return new PermissionsGuard(
      new Reflector(),
      { can: () => Promise.resolve(allowed) } as unknown as RbacService,
      audit,
    );
  }

  const user = { id: 'u1' } as User;

  it('без наклейки пропускает: этому окну права не нужны', async () => {
    expect(
      await guardWith(false).canActivate(contextFor(handlers.open, user)),
    ).toBe(true);
  });

  it('с правом пускает', async () => {
    expect(
      await guardWith(true).canActivate(contextFor(handlers.guarded, user)),
    ).toBe(true);
  });

  it('без права — 403', async () => {
    await expect(
      guardWith(false).canActivate(contextFor(handlers.guarded, user)),
    ).rejects.toThrow(/Недостаточно прав/);
  });

  it('без пользователя — 401: значит, забыли поставить JwtAuthGuard раньше', async () => {
    await expect(
      guardWith(true).canActivate(contextFor(handlers.guarded)),
    ).rejects.toThrow(UnauthorizedException);
  });
});

describe('Охранник раздела администратора', () => {
  const audit = {
    record: () => Promise.resolve(),
  } as unknown as RbacAuditService;

  function contextFor(user?: User): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user, method: 'GET', url: '/admin/rbac/roles' }),
      }),
    } as unknown as ExecutionContext;
  }

  function guardWith(isAdmin: boolean): AdminGuard {
    return new AdminGuard(
      { isAdmin: () => isAdmin } as unknown as RbacService,
      audit,
    );
  }

  it('администратора пускает', async () => {
    expect(
      await guardWith(true).canActivate(contextFor({ id: 'u1' } as User)),
    ).toBe(true);
  });

  it('остальных — 403', async () => {
    await expect(
      guardWith(false).canActivate(contextFor({ id: 'u1' } as User)),
    ).rejects.toThrow(/администратора/);
  });

  it('без пользователя — 401', async () => {
    await expect(guardWith(true).canActivate(contextFor())).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('Журнал событий входа', () => {
  /** Репозиторий, запоминающий записи; умеет разок сломаться. */
  function repository(failing = false) {
    const rows: Partial<AuthAuditLog>[] = [];

    return {
      rows,
      repo: {
        create: (row: Partial<AuthAuditLog>) => row,
        save: (row: Partial<AuthAuditLog>) => {
          if (failing) {
            return Promise.reject(new Error('база недоступна'));
          }

          rows.push(row);
          return Promise.resolve(row);
        },
      } as unknown as Repository<AuthAuditLog>,
    };
  }

  it('пишет событие целиком', async () => {
    const db = repository();

    await new AuditService(db.repo).record({
      event: AuthAuditEvent.LoginAttempt,
      success: true,
      email: 'a@b.com',
      userId: 'u1',
      ip: '10.0.0.1',
      userAgent: 'curl',
    });

    expect(db.rows[0]).toMatchObject({
      event: AuthAuditEvent.LoginAttempt,
      success: true,
      email: 'a@b.com',
      userId: 'u1',
      ip: '10.0.0.1',
    });
  });

  it('необязательные поля превращаются в null, а не пропадают', async () => {
    const db = repository();

    await new AuditService(db.repo).record({
      event: AuthAuditEvent.LoginAttempt,
      success: false,
      ip: null,
      userAgent: null,
    });

    expect(db.rows[0]).toMatchObject({
      email: null,
      userId: null,
      reason: null,
      userAgent: null,
    });
  });

  it('обрезает слишком длинный признак клиента', async () => {
    const db = repository();

    await new AuditService(db.repo).record({
      event: AuthAuditEvent.LoginAttempt,
      success: true,
      ip: null,
      userAgent: 'ж'.repeat(1000),
    });

    expect(db.rows[0]!.userAgent).toHaveLength(512);
  });

  it('упавшая запись в журнал не ломает вход', async () => {
    const db = repository(true);

    // Журнал важен, но не важнее самой операции
    await expect(
      new AuditService(db.repo).record({
        event: AuthAuditEvent.LoginAttempt,
        success: true,
        ip: null,
        userAgent: null,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('Настройки аутентификации', () => {
  /** Таблица настроек в памяти. */
  function repository(initial: AuthSettings | null) {
    let row = initial;

    return {
      get row() {
        return row;
      },
      repo: {
        findOne: () => Promise.resolve(row),
        create: (data: Partial<AuthSettings>) => data as AuthSettings,
        save: (data: AuthSettings) => {
          row = data;
          return Promise.resolve(data);
        },
        update: (_where: unknown, changes: Partial<AuthSettings>) => {
          row = { ...(row as AuthSettings), ...changes };
          return Promise.resolve({ affected: 1 });
        },
      } as unknown as Repository<AuthSettings>,
    };
  }

  it('при старте создаёт строку настроек, если её нет', async () => {
    const db = repository(null);

    await new AuthSettingsService(db.repo).onModuleInit();

    expect(db.row).not.toBeNull();
  });

  it('при старте не трогает существующие настройки', async () => {
    const existing = { id: 1, otpLength: 8 } as unknown as AuthSettings;
    const db = repository(existing);

    await new AuthSettingsService(db.repo).onModuleInit();

    expect(db.row).toBe(existing);
  });

  it('правка меняет только присланные поля', async () => {
    const db = repository({ id: 1, otpLength: 6 } as unknown as AuthSettings);

    const updated = await new AuthSettingsService(db.repo).update({
      otpLength: 8,
    } as Partial<AuthSettings>);

    expect(updated).toMatchObject({ id: 1, otpLength: 8 });
  });

  it('пропавшую строку настроек создаёт заново, а не падает', async () => {
    const db = repository(null);

    expect(await new AuthSettingsService(db.repo).get()).toBeTruthy();
  });
});

describe('Отправка писем', () => {
  it('в режиме console печатает письмо вместо отправки', async () => {
    const mail = new MailService(config({ MAIL_DRIVER: 'console' }));

    mail.onModuleInit();

    // Ничего не падает и никуда не ходит — этого достаточно
    await expect(
      mail.send({
        to: 'a@b.com',
        subject: 'Тема',
        text: 'Текст',
        html: '<p/>',
      }),
    ).resolves.toBeUndefined();
  });

  it('письмо с кодом содержит сам код и срок', () => {
    const letter = otpLetter('a@b.com', '123456', 10);

    expect(letter.to).toBe('a@b.com');
    expect(letter.subject).toContain('123456');
    expect(letter.text).toContain('123456');
    expect(letter.text).toContain('10');
    expect(letter.html).toContain('123456');
  });

  it('письмо со ссылкой содержит ссылку и срок', () => {
    const letter = magicLinkLetter('a@b.com', 'https://app/confirm?t=1', 15);

    expect(letter.text).toContain('https://app/confirm?t=1');
    expect(letter.html).toContain('https://app/confirm?t=1');
    expect(letter.text).toContain('15');
  });
});
