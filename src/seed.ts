import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { AppModule } from './app.module.js';
import { PasswordService } from './auth/password.service.js';
import { Grant } from './rbac/entities/grant.entity.js';
import { Permission } from './rbac/entities/permission.entity.js';
import { ADMIN_ROLE, Role } from './rbac/entities/role.entity.js';
import { RbacConfigService } from './rbac/rbac-config.service.js';
import { User, UserStatus } from './users/entities/user.entity.js';
import { USERS_ACTIONS } from './users/shared/users-permission.js';

/**
 * Наполнение базы для разработки и ручных проверок.
 *
 * Запуск: npm run seed
 *
 * Скрипт идемпотентный: гоняйте сколько нужно, дубликатов не появится —
 * всё создаётся по принципу «найти или создать». Существующие строки не
 * перетираются, чтобы не потерять то, что вы наменяли руками.
 *
 * Поднимается через createApplicationContext, а не NestFactory.create:
 * HTTP-сервер здесь не нужен, нужны только провайдеры и репозитории —
 * те же самые, что работают в приложении.
 */

const PASSWORD = 'secret123';

/** Пользователи с разными состояниями — чтобы фильтры списка было на чем смотреть. */
const PEOPLE = [
  { email: 'admin@example.com', role: ADMIN_ROLE, loggedInDaysAgo: 0 },
  { email: 'support@example.com', role: 'support', loggedInDaysAgo: 1 },
  { email: 'manager@example.com', role: 'manager', loggedInDaysAgo: 3 },
  { email: 'anna@example.com', role: null, loggedInDaysAgo: 2 },
  { email: 'boris@example.com', role: null, loggedInDaysAgo: 14 },
  { email: 'clara@example.com', role: null, loggedInDaysAgo: null },
  { email: 'dmitry@example.com', role: null, loggedInDaysAgo: null },
  {
    email: 'blocked@example.com',
    role: null,
    loggedInDaysAgo: 40,
    status: UserStatus.Blocked,
  },
  {
    email: 'pending@example.com',
    role: null,
    loggedInDaysAgo: null,
    status: UserStatus.PendingVerification,
  },
] as const;

/**
 * Роли и что каждой выдано.
 *
 * Пустой список действий означает «все действия разрешения» — так же, как
 * в назначениях через API.
 */
const ROLES = [
  {
    name: ADMIN_ROLE,
    description: 'Управление ролями, разрешениями и назначениями',
    actions: [] as string[],
  },
  {
    name: 'support',
    description: 'Поддержка: видит профили и почту, менять не может',
    actions: [USERS_ACTIONS.Read, USERS_ACTIONS.ReadEmail, USERS_ACTIONS.List],
  },
  {
    name: 'manager',
    description: 'Менеджер: видит и правит профили, почту не видит',
    actions: [USERS_ACTIONS.Read, USERS_ACTIONS.Update, USERS_ACTIONS.List],
  },
];

async function seed(): Promise<void> {
  const logger = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, {
    // Логи TypeORM здесь только мешают: строк много, все однотипные
    logger: ['log', 'warn', 'error'],
  });

  try {
    const users = app.get<Repository<User>>(getRepositoryToken(User));
    const roles = app.get<Repository<Role>>(getRepositoryToken(Role));
    const permissions = app.get<Repository<Permission>>(
      getRepositoryToken(Permission),
    );
    const grants = app.get<Repository<Grant>>(getRepositoryToken(Grant));
    const passwords = app.get(PasswordService);
    const rbacConfig = app.get(RbacConfigService);

    // ── Разрешение users со всеми действиями, которые понимает код ──
    // Список берём из USERS_ACTIONS, а не переписываем руками: добавится
    // новое действие — сид подхватит его сам.
    const allActions = Object.values(USERS_ACTIONS);
    let permission = await permissions.findOneBy({ name: 'users' });

    if (!permission) {
      permission = await permissions.save(
        permissions.create({ name: 'users', actions: allActions }),
      );
      logger.log(`Создано разрешение users: ${allActions.join(', ')}`);
    } else {
      // Разрешение есть, но действия могли устареть — дополняем
      const missing = allActions.filter(
        (action) => !permission!.actions.includes(action),
      );

      if (missing.length > 0) {
        permission.actions = [...permission.actions, ...missing];
        await permissions.save(permission);
        logger.log(
          `Разрешению users добавлены действия: ${missing.join(', ')}`,
        );
      }
    }

    // ── Роли и назначения ──
    const roleByName = new Map<string, Role>();

    for (const spec of ROLES) {
      let role = await roles.findOneBy({ name: spec.name });

      if (!role) {
        role = await roles.save(
          roles.create({ name: spec.name, description: spec.description }),
        );
        logger.log(`Создана роль ${spec.name}`);
      }

      roleByName.set(spec.name, role);

      const existing = await grants.findOneBy({
        roleId: role.id,
        permissionId: permission.id,
      });

      if (!existing) {
        await grants.save(
          grants.create({
            roleId: role.id,
            permissionId: permission.id,
            actions: spec.actions,
          }),
        );
        logger.log(
          `Роли ${spec.name} выдано users: ` +
            (spec.actions.length > 0
              ? spec.actions.join(', ')
              : 'все действия'),
        );
      }
    }

    // ── Пользователи ──
    // Отпечаток пароля считаем один раз: bcrypt намеренно медленный, и на
    // девяти пользователях разница уже заметна. Пароль у всех одинаковый.
    const passwordHash = await passwords.hash(PASSWORD);
    let created = 0;

    for (const person of PEOPLE) {
      const existing = await users.findOne({
        where: { email: person.email },
        relations: { roles: true },
      });

      const status = 'status' in person ? person.status : UserStatus.Active;

      const user =
        existing ??
        (await users.save(
          users.create({
            email: person.email,
            passwordHash,
            status,
            // Активному аккаунту почта считается подтверждённой: иначе он
            // не отличался бы от pending, и проверять было бы нечего
            emailVerifiedAt:
              status === UserStatus.PendingVerification ? null : new Date(),
            lastLoginAt:
              person.loggedInDaysAgo === null
                ? null
                : daysAgo(person.loggedInDaysAgo),
          }),
        ));

      if (!existing) {
        created += 1;
      }

      // Роль назначаем всегда, даже существующему: связка могла пропасть
      if (person.role) {
        const role = roleByName.get(person.role);
        const already = (user.roles ?? []).some((r) => r.id === role?.id);

        if (role && !already) {
          user.roles = [...(user.roles ?? []), role];
          await users.save(user);
          logger.log(`${person.email} → роль ${person.role}`);
        }
      }
    }

    logger.log(
      `Пользователей создано: ${created}, всего в списке: ${PEOPLE.length}`,
    );

    // Правила изменились в базе напрямую — конфигурацию надо перечитать,
    // иначе запущенное приложение работало бы по старой.
    await rbacConfig.reload();

    logger.log(`Готово. Пароль у всех: ${PASSWORD}`);
  } finally {
    // Без этого процесс не завершится: пул соединений с базой держит его
    await app.close();
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

await seed();
