import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Grant } from './entities/grant.entity.js';
import { Permission } from './entities/permission.entity.js';
import {
  RbacAuditEntity,
  RbacAuditOperation,
} from './entities/rbac-audit-log.entity.js';
import { Role } from './entities/role.entity.js';
import { RbacAuditService } from './rbac-audit.service.js';

/** Разрешение так, как его удобно проверять: действия — множеством. */
interface PermissionConfig {
  id: string;
  actions: Set<string>;
}

/**
 * Готовая к проверкам конфигурация. Лежит в памяти одним объектом, который
 * при перезагрузке заменяется целиком. Поэтому проверка никогда не увидит
 * полуобновлённое состояние: она работает со снимком, который взяла в
 * начале, даже если параллельно идёт reload().
 */
export interface RbacConfig {
  /** название разрешения → его описание */
  permissions: Map<string, PermissionConfig>;
  /**
   * номер роли → название разрешения → выданные действия.
   * null вместо множества означает «все действия разрешения».
   */
  grants: Map<string, Map<string, Set<string> | null>>;
  /** номер роли → название: нужно для понятных сообщений в логах */
  roleNames: Map<string, string>;
  loadedAt: Date;
}

/**
 * Загрузка и кеш конфигурации RBAC.
 *
 * Зачем кеш: проверка прав случается на каждом закрытом запросе, а правила
 * меняются раз в месяц. Ходить за ними в базу каждый раз — три запроса на
 * ровном месте.
 *
 * Почему это всё равно «без перезапуска»: каждая операция администратора в
 * конце вызывает reload(). Правила поменяли прямо в базе, мимо приложения —
 * есть та же reload() снаружи: POST /admin/rbac/reload.
 *
 * Ограничение назовём честно: кеш живёт в памяти процесса. Запустив
 * несколько копий приложения, вы получите несколько кешей, и reload() в
 * одной копии не тронет остальные. Лечится общим кешем (Redis) с рассылкой
 * события инвалидации — это за рамками текущего шага.
 */
@Injectable()
export class RbacConfigService implements OnModuleInit {
  private readonly logger = new Logger(RbacConfigService.name);

  private config: RbacConfig | null = null;

  /**
   * Загрузка, идущая прямо сейчас. Если во время неё придут ещё десять
   * запросов, все они дождутся этого же обещания, а не запустят десять
   * параллельных загрузок.
   */
  private loading: Promise<RbacConfig> | null = null;

  constructor(
    @InjectRepository(Role)
    private readonly roles: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    @InjectRepository(Grant)
    private readonly grants: Repository<Grant>,
    private readonly audit: RbacAuditService,
  ) {}

  /** Сценарий 3 из ТЗ: загрузка конфигурации при старте приложения. */
  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /** Конфигурация для проверки. Кеша нет — загрузим и запомним. */
  getConfig(): Promise<RbacConfig> {
    if (this.config) {
      return Promise.resolve(this.config);
    }

    // Загрузка уже идёт — присоединяемся к ней
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });

    return this.loading;
  }

  /**
   * Сбросить кеш, ничего не загружая прямо сейчас.
   * Следующая проверка прав загрузит конфигурацию сама.
   */
  invalidate(): void {
    this.config = null;
    this.logger.log('Кеш конфигурации RBAC сброшен');
  }

  /** Сбросить кеш и сразу перечитать правила из базы. */
  async reload(actorUserId: string | null = null): Promise<RbacConfig> {
    this.invalidate();
    const config = await this.getConfig();

    await this.audit.record({
      actorUserId,
      operation: RbacAuditOperation.ReloadConfig,
      entity: RbacAuditEntity.Config,
      statusCode: 200,
      reason: `разрешений ${config.permissions.size}, ролей с правами ${config.grants.size}`,
    });

    return config;
  }

  /** Когда конфигурацию читали в последний раз. */
  get loadedAt(): Date | null {
    return this.config?.loadedAt ?? null;
  }

  // Три запроса в базу и сборка удобных для проверки структур.
  private async load(): Promise<RbacConfig> {
    const started = Date.now();

    const [roles, permissions, grants] = await Promise.all([
      this.roles.find(),
      this.permissions.find(),
      this.grants.find(),
    ]);

    const permissionsByName = new Map<string, PermissionConfig>();
    // Назначения ссылаются на разрешение номером, а проверка приходит с
    // названием. Эта карта переводит одно в другое.
    const permissionNameById = new Map<string, string>();

    for (const permission of permissions) {
      permissionsByName.set(permission.name, {
        id: permission.id,
        actions: new Set(permission.actions),
      });
      permissionNameById.set(permission.id, permission.name);
    }

    const grantsByRole = new Map<string, Map<string, Set<string> | null>>();

    for (const grant of grants) {
      const permissionName = permissionNameById.get(grant.permissionId);

      if (!permissionName) {
        // Такого быть не должно: внешний ключ не даст сослаться в пустоту.
        // Но если строку удалили в обход приложения — лучше пропустить одно
        // назначение и сказать об этом, чем уронить загрузку целиком.
        this.logger.warn(
          `Назначение ${grant.id} ссылается на несуществующее разрешение ${grant.permissionId} — пропущено`,
        );
        continue;
      }

      const forRole =
        grantsByRole.get(grant.roleId) ?? new Map<string, Set<string> | null>();

      // Пустой список действий = все действия разрешения
      forRole.set(
        permissionName,
        grant.actions.length === 0 ? null : new Set(grant.actions),
      );

      grantsByRole.set(grant.roleId, forRole);
    }

    const config: RbacConfig = {
      permissions: permissionsByName,
      grants: grantsByRole,
      roleNames: new Map(roles.map((role) => [role.id, role.name])),
      loadedAt: new Date(),
    };

    this.config = config;

    this.logger.log(
      `Конфигурация RBAC загружена за ${Date.now() - started} мс: ` +
        `ролей ${roles.length}, разрешений ${permissions.length}, назначений ${grants.length}`,
    );

    return config;
  }
}
