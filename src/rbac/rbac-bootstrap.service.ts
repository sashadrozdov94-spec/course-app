import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Env } from '../config/env.schema.js';
import { User } from '../users/entities/user.entity.js';
import { ADMIN_ROLE, Role } from './entities/role.entity.js';
import { RbacConfigService } from './rbac-config.service.js';

/**
 * Первый администратор.
 *
 * Задача с курицей и яйцом: раздел /admin/rbac/* закрыт ролью admin, а
 * выдать роль можно только через... этот же раздел. Разрывать круг через
 * API нельзя — это была бы дыра размером с систему. Поэтому:
 *
 *   1. роль admin создаётся при старте, если её нет;
 *   2. если в .env указан RBAC_BOOTSTRAP_ADMIN_EMAIL, роль выдаётся этому
 *      пользователю при старте приложения.
 *
 * Второй шаг — сознательно операция уровня сервера, а не HTTP: право
 * назначить администратора есть у того, кто может править .env, то есть у
 * владельца машины. После первого запуска переменную можно убрать.
 */
@Injectable()
export class RbacBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(RbacBootstrapService.name);

  constructor(
    @InjectRepository(Role)
    private readonly roles: Repository<Role>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly config: ConfigService<Env, true>,
    private readonly rbacConfig: RbacConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const role = await this.ensureAdminRole();
    const email = this.config
      .get('RBAC_BOOTSTRAP_ADMIN_EMAIL', { infer: true })
      .trim();

    if (!email) {
      return;
    }

    await this.assignAdmin(email, role);
  }

  private async ensureAdminRole(): Promise<Role> {
    const existing = await this.roles.findOneBy({ name: ADMIN_ROLE });

    if (existing) {
      return existing;
    }

    const created = await this.roles.save(
      this.roles.create({
        name: ADMIN_ROLE,
        description: 'Управление ролями, разрешениями и назначениями',
      }),
    );

    this.logger.log('Создана роль admin');
    // Конфигурацию перечитываем: её загрузка могла случиться раньше нас
    await this.rbacConfig.reload();

    return created;
  }

  private async assignAdmin(email: string, role: Role): Promise<void> {
    const user = await this.users.findOne({
      where: { email },
      relations: { roles: true },
    });

    if (!user) {
      // Не падаем: обычная ситуация на чистой базе, когда пользователь
      // ещё не зарегистрировался. Скажем об этом и пойдём дальше.
      this.logger.warn(
        `RBAC_BOOTSTRAP_ADMIN_EMAIL=${email}: такого пользователя нет, роль admin не выдана`,
      );
      return;
    }

    if (user.roles.some((assigned) => assigned.id === role.id)) {
      return;
    }

    user.roles = [...user.roles, role];
    await this.users.save(user);

    this.logger.log(`Пользователю ${email} выдана роль admin`);
  }
}
