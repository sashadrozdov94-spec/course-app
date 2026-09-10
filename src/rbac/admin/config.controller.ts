import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import type { User } from '../../users/entities/user.entity.js';
import { AdminGuard } from '../guards/admin.guard.js';
import { RbacConfigService } from '../rbac-config.service.js';

interface ConfigSnapshot {
  loadedAt: Date | null;
  permissions: { name: string; actions: string[] }[];
  roles: {
    id: string;
    name: string;
    grants: { permission: string; actions: string[]; allActions: boolean }[];
  }[];
}

/**
 * Конфигурация целиком и её принудительная перезагрузка.
 *
 * Зачем ручная перезагрузка, если каждая операция администратора и так
 * перечитывает правила: сценарий 2 из ТЗ говорит про изменение правил
 * прямо в базе. Такое изменение приложение заметить не может — вот кнопка.
 */
@ApiTags('Администратор: конфигурация RBAC')
@ApiCookieAuth('access_token')
@ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
@ApiResponse({ status: 403, description: 'Требуется роль admin' })
@Controller('admin/rbac')
@UseGuards(JwtAuthGuard, AdminGuard)
export class RbacConfigController {
  constructor(private readonly configService: RbacConfigService) {}

  /** GET /admin/rbac/config — что сейчас лежит в памяти приложения. */
  @ApiOperation({
    summary: 'Что сейчас в памяти приложения',
    description: 'Снимок загруженной конфигурации: разрешения и права ролей.',
  })
  @ApiResponse({ status: 200, description: 'Снимок конфигурации' })
  @Get('config')
  async snapshot(): Promise<ConfigSnapshot> {
    const config = await this.configService.getConfig();

    return {
      loadedAt: config.loadedAt,
      permissions: [...config.permissions].map(([name, permission]) => ({
        name,
        actions: [...permission.actions],
      })),
      roles: [...config.roleNames].map(([id, name]) => ({
        id,
        name,
        grants: [...(config.grants.get(id) ?? [])].map(
          ([permission, actions]) => ({
            permission,
            actions: actions ? [...actions] : [],
            // null в конфигурации = «все действия разрешения»
            allActions: actions === null,
          }),
        ),
      })),
    };
  }

  /** POST /admin/rbac/reload — сбросить кеш и перечитать правила из базы. */
  @ApiOperation({
    summary: 'Сбросить кеш и перечитать правила',
    description:
      'Нужно, если правила изменили прямо в базе: операции через API ' +
      'перечитывают конфигурацию сами.',
  })
  @ApiResponse({ status: 200, description: 'Конфигурация перезагружена' })
  @Post('reload')
  @HttpCode(200)
  async reload(@CurrentUser() me: User): Promise<{ loadedAt: Date }> {
    const config = await this.configService.reload(me.id);
    return { loadedAt: config.loadedAt };
  }
}
