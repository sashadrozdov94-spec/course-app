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
@Controller('admin/rbac/roles')
@UseGuards(JwtAuthGuard, AdminGuard)
export class RbacRolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  findAll(): Promise<RoleView[]> {
    return this.rolesService.findAll();
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createRoleSchema)) dto: CreateRoleDto,
    @CurrentUser() me: User,
  ): Promise<RoleView> {
    return this.rolesService.create(dto, me.id);
  }

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
