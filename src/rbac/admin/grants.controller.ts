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
@Controller('admin/rbac/grants')
@UseGuards(JwtAuthGuard, AdminGuard)
export class RbacGrantsController {
  constructor(private readonly grantsService: GrantsService) {}

  @Get()
  findAll(): Promise<GrantView[]> {
    return this.grantsService.findAll();
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createGrantSchema)) dto: CreateGrantDto,
    @CurrentUser() me: User,
  ): Promise<GrantView> {
    return this.grantsService.create(dto, me.id);
  }

  @Put(':grantId')
  update(
    @Param(new ZodValidationPipe(grantIdParamSchema))
    params: { grantId: string },
    @Body(new ZodValidationPipe(updateGrantSchema)) dto: UpdateGrantDto,
    @CurrentUser() me: User,
  ): Promise<GrantView> {
    return this.grantsService.update(params.grantId, dto, me.id);
  }

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
