import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { User } from '../../users/entities/user.entity.js';
import {
  type CreatePermissionDto,
  createPermissionSchema,
  permissionIdParamSchema,
  type PermissionView,
  type UpdatePermissionDto,
  updatePermissionSchema,
} from '../dto/permission.dto.js';
import { AdminGuard } from '../guards/admin.guard.js';
import { PermissionsService } from '../permissions.service.js';

// Управление разрешениями (п. 1.3.3 ТЗ)
@Controller('admin/rbac/permissions')
@UseGuards(JwtAuthGuard, AdminGuard)
export class RbacPermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get()
  findAll(): Promise<PermissionView[]> {
    return this.permissionsService.findAll();
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createPermissionSchema))
    dto: CreatePermissionDto,
    @CurrentUser() me: User,
  ): Promise<PermissionView> {
    return this.permissionsService.create(dto, me.id);
  }

  @Put(':permissionId')
  update(
    @Param(new ZodValidationPipe(permissionIdParamSchema))
    params: { permissionId: string },
    @Body(new ZodValidationPipe(updatePermissionSchema))
    dto: UpdatePermissionDto,
    @CurrentUser() me: User,
  ): Promise<PermissionView> {
    return this.permissionsService.update(params.permissionId, dto, me.id);
  }

  // Разрешение с назначениями не удаляется никак: только 409 (см. сервис)
  @Delete(':permissionId')
  @HttpCode(200)
  async remove(
    @Param(new ZodValidationPipe(permissionIdParamSchema))
    params: { permissionId: string },
    @CurrentUser() me: User,
  ): Promise<{ id: string; deleted: true }> {
    await this.permissionsService.remove(params.permissionId, me.id);
    return { id: params.permissionId, deleted: true };
  }
}
