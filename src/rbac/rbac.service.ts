import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ADMIN_ROLE } from './entities/role.entity.js';
import { RbacConfigService } from './rbac-config.service.js';

/**
 * Тот, чей доступ проверяем. Не сам User, а только нужные поля: так эту
 * проверку можно вызвать и из теста, и из фонового задания, где полного
 * пользователя нет.
 */
export interface RbacSubject {
  id: string;
  roles: { id: string; name: string }[];
}

/** Разбор записи «ресурс@действие» из ТЗ. */
export function parsePermissionRef(reference: string): {
  permission: string;
  action: string;
} {
  const separator = reference.indexOf('@');

  if (separator <= 0 || separator === reference.length - 1) {
    // Это ошибка программиста в наклейке @RequirePermission, а не клиента.
    // Падаем сразу и громко, чтобы опечатку заметили на первом же запросе.
    throw new Error(
      `Некорректная запись разрешения: "${reference}". Ожидается «ресурс@действие»`,
    );
  }

  return {
    permission: reference.slice(0, separator),
    action: reference.slice(separator + 1),
  };
}

/**
 * Проверка доступа (п. 1.3.1 ТЗ).
 *
 * В базу здесь не ходим: все решения принимаются по конфигурации, которую
 * держит в памяти RbacConfigService. Одна проверка — это несколько
 * обращений к Map, то есть практически бесплатно.
 */
@Injectable()
export class RbacService {
  private readonly logger = new Logger(RbacService.name);

  constructor(private readonly configService: RbacConfigService) {}

  /** Есть ли у администратора особая роль. */
  isAdmin(user: RbacSubject): boolean {
    return user.roles.some((role) => role.name === ADMIN_ROLE);
  }

  /**
   * Можно ли пользователю сделать action над permission.
   *
   * Шаги ровно по ТЗ:
   *   1. взять роли пользователя;
   *   2. для каждой роли найти назначения в конфигурации;
   *   3. проверить разрешение и действие;
   *   4. назначение без действий — доступны все действия разрешения;
   *   5. назначение с действиями — доступны только они;
   *   6. нашли совпадение — доступ есть;
   *   7. не нашли — доступа нет.
   */
  async can(
    user: RbacSubject,
    permission: string,
    action: string,
  ): Promise<boolean> {
    // 1. Без ролей проверять нечего — в конфигурации для него ничего нет
    if (user.roles.length === 0) {
      return false;
    }

    const config = await this.configService.getConfig();

    const known = config.permissions.get(permission);

    // Разрешения нет в конфигурации. Скорее всего опечатка в наклейке или
    // разрешение удалили, забыв про эндпоинт. Отказываем и пишем в лог:
    // молча пропускать неизвестное разрешение — дыра.
    if (!known) {
      this.logger.warn(
        `Проверка неизвестного разрешения "${permission}" (пользователь ${user.id}) — отказано`,
      );
      return false;
    }

    // Действие не входит в список допустимых для этого разрешения.
    // Даже если кто-то выдал его назначением — оно недействительно.
    if (!known.actions.has(action)) {
      this.logger.warn(
        `Действие "${action}" не объявлено у разрешения "${permission}" — отказано`,
      );
      return false;
    }

    // 2-6. Хватает одной роли, которая даёт это право
    for (const role of user.roles) {
      const granted = config.grants.get(role.id)?.get(permission);

      // У этой роли такого разрешения нет — смотрим следующую
      if (granted === undefined) {
        continue;
      }

      // 4. null = назначение без списка действий = доступны все
      if (granted === null || granted.has(action)) {
        return true;
      }
    }

    // 7. Ни одна роль не подошла
    return false;
  }

  /**
   * Все действия разрешения, которые доступны пользователю.
   *
   * Зачем отдельно от can(): когда нужно не «можно ли одно действие», а
   * «что вообще можно» — например, чтобы собрать список разрешённых полей
   * профиля. Через can() пришлось бы перебирать действия по одному и на
   * каждое лишнее получать предупреждение в лог.
   *
   * Возвращается пересечение выданного с объявленным у разрешения:
   * действие, которое роли выдали, но из разрешения потом убрали,
   * в набор не попадёт.
   */
  async allowedActions(
    user: RbacSubject,
    permission: string,
  ): Promise<Set<string>> {
    const allowed = new Set<string>();

    if (user.roles.length === 0) {
      return allowed;
    }

    const config = await this.configService.getConfig();
    const known = config.permissions.get(permission);

    if (!known) {
      return allowed;
    }

    for (const role of user.roles) {
      const granted = config.grants.get(role.id)?.get(permission);

      if (granted === undefined) {
        continue;
      }

      // null = назначение без списка действий = все действия разрешения
      if (granted === null) {
        return new Set(known.actions);
      }

      for (const action of granted) {
        if (known.actions.has(action)) {
          allowed.add(action);
        }
      }
    }

    return allowed;
  }

  /** То же самое, но вместо false бросает 403 — удобно внутри сервисов. */
  async check(
    user: RbacSubject,
    permission: string,
    action: string,
  ): Promise<void> {
    if (!(await this.can(user, permission, action))) {
      throw new ForbiddenException('Недостаточно прав');
    }
  }

  /** Короткая форма: canRef(user, 'users@read_any'). */
  async canRef(user: RbacSubject, reference: string): Promise<boolean> {
    const { permission, action } = parsePermissionRef(reference);
    return this.can(user, permission, action);
  }
}
