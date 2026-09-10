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
import { ApiZodBody } from '../../common/openapi/zod-openapi.js';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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
@ApiTags('Администратор: разрешения')
@ApiCookieAuth('access_token')
@ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
@ApiResponse({ status: 403, description: 'Требуется роль admin' })
@Controller('admin/rbac/permissions')
@UseGuards(JwtAuthGuard, AdminGuard)
export class RbacPermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @ApiOperation({ summary: 'Разрешение: список' })
  @ApiResponse({ status: 200, description: 'Список' })
  @Get()
  findAll(): Promise<PermissionView[]> {
    return this.permissionsService.findAll();
  }

  @ApiOperation({ summary: 'Разрешение: создать' })
  @ApiZodBody(createPermissionSchema)
  @ApiResponse({ status: 201, description: 'Создано' })
  @ApiResponse({ status: 400, description: 'Некорректные данные' })
  @ApiResponse({ status: 404, description: 'Связанная сущность не найдена' })
  @ApiResponse({ status: 409, description: 'Дубликат' })
  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createPermissionSchema))
    dto: CreatePermissionDto,
    @CurrentUser() me: User,
  ): Promise<PermissionView> {
    return this.permissionsService.create(dto, me.id);
  }

  @ApiOperation({ summary: 'Разрешение: изменить' })
  @ApiParam({ name: 'permissionId', format: 'uuid' })
  @ApiZodBody(updatePermissionSchema)
  @ApiResponse({ status: 200, description: 'Изменено' })
  @ApiResponse({ status: 400, description: 'Некорректные данные' })
  @ApiResponse({ status: 404, description: 'Не найдено' })
  @ApiResponse({ status: 409, description: 'Дубликат или защищённая сущность' })
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
  @ApiOperation({ summary: 'Разрешение: удалить' })
  @ApiParam({ name: 'permissionId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Удалено' })
  @ApiResponse({ status: 404, description: 'Не найдено' })
  @ApiResponse({
    status: 409,
    description: 'Есть назначения или сущность защищена',
  })
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
