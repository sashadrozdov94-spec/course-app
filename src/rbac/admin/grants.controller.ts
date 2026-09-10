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
  type CreateGrantDto,
  createGrantSchema,
  grantIdParamSchema,
  type GrantView,
  type UpdateGrantDto,
  updateGrantSchema,
} from '../dto/grant.dto.js';
import { GrantsService } from '../grants.service.js';
import { AdminGuard } from '../guards/admin.guard.js';

// Управление назначениями (п. 1.3.4 ТЗ)
@ApiTags('Администратор: назначения')
@ApiCookieAuth('access_token')
@ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
@ApiResponse({ status: 403, description: 'Требуется роль admin' })
@Controller('admin/rbac/grants')
@UseGuards(JwtAuthGuard, AdminGuard)
export class RbacGrantsController {
  constructor(private readonly grantsService: GrantsService) {}

  @ApiOperation({ summary: 'Назначение: список' })
  @ApiResponse({ status: 200, description: 'Список' })
  @Get()
  findAll(): Promise<GrantView[]> {
    return this.grantsService.findAll();
  }

  @ApiOperation({ summary: 'Назначение: создать' })
  @ApiZodBody(createGrantSchema)
  @ApiResponse({ status: 201, description: 'Создано' })
  @ApiResponse({ status: 400, description: 'Некорректные данные' })
  @ApiResponse({ status: 404, description: 'Связанная сущность не найдена' })
  @ApiResponse({ status: 409, description: 'Дубликат' })
  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createGrantSchema)) dto: CreateGrantDto,
    @CurrentUser() me: User,
  ): Promise<GrantView> {
    return this.grantsService.create(dto, me.id);
  }

  @ApiOperation({ summary: 'Назначение: изменить' })
  @ApiParam({ name: 'grantId', format: 'uuid' })
  @ApiZodBody(updateGrantSchema)
  @ApiResponse({ status: 200, description: 'Изменено' })
  @ApiResponse({ status: 400, description: 'Некорректные данные' })
  @ApiResponse({ status: 404, description: 'Не найдено' })
  @ApiResponse({ status: 409, description: 'Дубликат или защищённая сущность' })
  @Put(':grantId')
  update(
    @Param(new ZodValidationPipe(grantIdParamSchema))
    params: { grantId: string },
    @Body(new ZodValidationPipe(updateGrantSchema)) dto: UpdateGrantDto,
    @CurrentUser() me: User,
  ): Promise<GrantView> {
    return this.grantsService.update(params.grantId, dto, me.id);
  }

  @ApiOperation({ summary: 'Назначение: удалить' })
  @ApiParam({ name: 'grantId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Удалено' })
  @ApiResponse({ status: 404, description: 'Не найдено' })
  @ApiResponse({
    status: 409,
    description: 'Есть назначения или сущность защищена',
  })
  @Delete(':grantId')
  @HttpCode(200)
  async remove(
    @Param(new ZodValidationPipe(grantIdParamSchema))
    params: { grantId: string },
    @CurrentUser() me: User,
  ): Promise<{ id: string; deleted: true }> {
    await this.grantsService.remove(params.grantId, me.id);
    return { id: params.grantId, deleted: true };
  }
}
