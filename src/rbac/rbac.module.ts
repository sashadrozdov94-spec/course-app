import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity.js';
import { Grant } from './entities/grant.entity.js';
import { Permission } from './entities/permission.entity.js';
import { RbacAuditLog } from './entities/rbac-audit-log.entity.js';
import { Role } from './entities/role.entity.js';
import { GrantsService } from './grants.service.js';
import { AdminGuard } from './guards/admin.guard.js';
import { PermissionsGuard } from './guards/permissions.guard.js';
import { PermissionsService } from './permissions.service.js';
import { RbacAuditService } from './rbac-audit.service.js';
import { RbacBootstrapService } from './rbac-bootstrap.service.js';
import { RbacConfigService } from './rbac-config.service.js';
import { RbacService } from './rbac.service.js';
import { RolesService } from './roles.service.js';

/**
 * Ядро RBAC: сущности, конфигурация, проверка прав, охранники.
 *
 * Контроллеров здесь нет специально. Им нужен JwtAuthGuard, а тому —
 * UsersService; при этом UsersModule сам импортирует RbacModule, чтобы
 * проверять права. Получилось бы кольцо. Поэтому контроллеры живут в
 * отдельном RbacAdminModule, который импортирует обе коробки, а эта
 * коробка не знает про users ничего, кроме таблицы (нужна для выдачи
 * первой роли admin при старте).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Role, Permission, Grant, RbacAuditLog, User]),
  ],
  providers: [
    RbacAuditService,
    RbacConfigService,
    RbacService,
    RbacBootstrapService,
    RolesService,
    PermissionsService,
    GrantsService,
    PermissionsGuard,
    AdminGuard,
  ],
  exports: [
    RbacService,
    // Нужен наружу не сам по себе, а охранникам: @UseGuards(AdminGuard)
    // создаёт свой экземпляр охранника в модуле контроллера, поэтому все
    // его зависимости должны быть видны и там.
    RbacAuditService,
    RbacConfigService,
    RolesService,
    PermissionsService,
    GrantsService,
    PermissionsGuard,
    AdminGuard,
  ],
})
export class RbacModule {}
