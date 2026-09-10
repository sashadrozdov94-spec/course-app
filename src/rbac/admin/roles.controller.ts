import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
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
import { type ForceQuery, forceQuerySchema } from '../dto/identifiers.js';
import {
  type CreateRoleDto,
  createRoleSchema,
  roleIdParamSchema,
  type RoleView,
  type UpdateRoleDto,
  updateRoleSchema,
} from '../dto/role.dto.js';
import { AdminGuard } from '../guards/admin.guard.js';
import { RolesService } from '../roles.service.js';

/**
 * Управление ролями (п. 1.3.2 ТЗ).
 *
 * Два охранника подряд: сначала JwtAuthGuard узнаёт, кто пришёл, потом
 * AdminGuard решает, пускать ли. Порядок именно такой — второму нужен
 * результат работы первого.
 */
@ApiTags('Администратор: роли')
@ApiCookieAuth('access_token')
@ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
@ApiResponse({ status: 403, description: 'Требуется роль admin' })
@Controller('admin/rbac/roles')
@UseGuards(JwtAuthGuard, AdminGuard)
export class RbacRolesController {
  constructor(private readonly rolesService: RolesService) {}

  @ApiOperation({ summary: 'Роль: список' })
  @ApiResponse({ status: 200, description: 'Список' })
  @Get()
  findAll(): Promise<RoleView[]> {
    return this.rolesService.findAll();
  }

  @ApiOperation({ summary: 'Роль: создать' })
  @ApiZodBody(createRoleSchema)
  @ApiResponse({ status: 201, description: 'Создано' })
  @ApiResponse({ status: 400, description: 'Некорректные данные' })
  @ApiResponse({ status: 404, description: 'Связанная сущность не найдена' })
  @ApiResponse({ status: 409, description: 'Дубликат' })
  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createRoleSchema)) dto: CreateRoleDto,
    @CurrentUser() me: User,
  ): Promise<RoleView> {
    return this.rolesService.create(dto, me.id);
  }

  @ApiOperation({ summary: 'Роль: изменить' })
  @ApiParam({ name: 'roleId', format: 'uuid' })
  @ApiZodBody(updateRoleSchema)
  @ApiResponse({ status: 200, description: 'Изменено' })
  @ApiResponse({ status: 400, description: 'Некорректные данные' })
  @ApiResponse({ status: 404, description: 'Не найдено' })
  @ApiResponse({ status: 409, description: 'Дубликат или защищённая сущность' })
  @Put(':roleId')
  update(
    @Param(new ZodValidationPipe(roleIdParamSchema))
    params: { roleId: string },
    @Body(new ZodValidationPipe(updateRoleSchema)) dto: UpdateRoleDto,
    @CurrentUser() me: User,
  ): Promise<RoleView> {
    return this.rolesService.update(params.roleId, dto, me.id);
  }

  /**
   * DELETE /admin/rbac/roles/{roleId}?force=true
   *
   * Без force роль с назначениями не удалится — ответ 409.
   * По ТЗ ответ на успех — 200, поэтому не 204: тело с подтверждением есть.
   */
  @ApiOperation({ summary: 'Роль: удалить' })
  @ApiParam({ name: 'roleId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Удалено' })
  @ApiResponse({ status: 404, description: 'Не найдено' })
  @ApiResponse({
    status: 409,
    description: 'Есть назначения или сущность защищена',
  })
  @Delete(':roleId')
  @HttpCode(200)
  async remove(
    @Param(new ZodValidationPipe(roleIdParamSchema))
    params: { roleId: string },
    @Query(new ZodValidationPipe(forceQuerySchema)) query: ForceQuery,
    @CurrentUser() me: User,
  ): Promise<{ id: string; deleted: true }> {
    await this.rolesService.remove(params.roleId, query.force, me.id);
    return { id: params.roleId, deleted: true };
  }
}
