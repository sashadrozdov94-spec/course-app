import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { TokenModule } from '../auth/token.module.js';
import { UsersModule } from '../users/users.module.js';
import { RbacConfigController } from './admin/config.controller.js';
import { RbacGrantsController } from './admin/grants.controller.js';
import { RbacPermissionsController } from './admin/permissions.controller.js';
import { RbacRolesController } from './admin/roles.controller.js';
import { RbacModule } from './rbac.module.js';

/**
 * Раздел администратора: /admin/rbac/*.
 *
 * Отдельная коробка, чтобы не было кольца RbacModule ↔ UsersModule.
 * Здесь только контроллеры; вся работа — в сервисах из RbacModule.
 *
 * JwtAuthGuard объявлен провайдером, как и в UsersModule: ему нужны
 * TokenService и UsersService, обе коробки импортированы рядом.
 */
@Module({
  imports: [RbacModule, TokenModule, UsersModule],
  controllers: [
    RbacRolesController,
    RbacPermissionsController,
    RbacGrantsController,
    RbacConfigController,
  ],
  providers: [JwtAuthGuard],
})
export class RbacAdminModule {}
