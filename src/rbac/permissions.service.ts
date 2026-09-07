import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  CreatePermissionDto,
  UpdatePermissionDto,
} from './dto/permission.dto.js';
import { type PermissionView, toPermissionView } from './dto/permission.dto.js';
import { Grant } from './entities/grant.entity.js';
import { Permission } from './entities/permission.entity.js';
import {
  RbacAuditEntity,
  RbacAuditOperation,
} from './entities/rbac-audit-log.entity.js';
import { RbacAuditService } from './rbac-audit.service.js';
import { RbacConfigService } from './rbac-config.service.js';

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  constructor(
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    @InjectRepository(Grant)
    private readonly grants: Repository<Grant>,
    private readonly audit: RbacAuditService,
    private readonly config: RbacConfigService,
  ) {}

  async findAll(): Promise<PermissionView[]> {
    const permissions = await this.permissions.find({ order: { name: 'ASC' } });
    return permissions.map(toPermissionView);
  }

  async create(
    dto: CreatePermissionDto,
    actorUserId: string,
  ): Promise<PermissionView> {
    const permission = this.permissions.create({
      id: dto.id,
      name: dto.name,
      actions: dto.actions,
    });

    let saved: Permission;

    try {
      saved = await this.permissions.save(permission);
    } catch (error) {
      throw await this.conflict(error, actorUserId, null);
    }

    await this.audit.record({
      actorUserId,
      operation: RbacAuditOperation.Create,
      entity: RbacAuditEntity.Permission,
      entityId: saved.id,
      statusCode: 201,
    });

    await this.config.reload(actorUserId);

    return toPermissionView(saved);
  }

  async update(
    id: string,
    dto: UpdatePermissionDto,
    actorUserId: string,
  ): Promise<PermissionView> {
    const permission = await this.findOrFail(
      id,
      actorUserId,
      RbacAuditOperation.Update,
    );

    if (dto.actions) {
      await this.warnAboutLostActions(permission, dto.actions);
      permission.actions = dto.actions;
    }

    if (dto.name !== undefined) {
      permission.name = dto.name;
    }

    let saved: Permission;

    try {
      saved = await this.permissions.save(permission);
    } catch (error) {
      throw await this.conflict(error, actorUserId, id);
    }

    await this.audit.record({
      actorUserId,
      operation: RbacAuditOperation.Update,
      entity: RbacAuditEntity.Permission,
      entityId: id,
      statusCode: 200,
    });

    await this.config.reload(actorUserId);

    return toPermissionView(saved);
  }

  /**
   * Удаление разрешения.
   *
   * Здесь ТЗ не оставляет выбора: есть назначения — 409, и точка. Никакого
   * ?force=true, как у ролей: удалить разрешение — значит снять право сразу
   * со всех ролей, которым оно выдано. Пусть администратор сначала уберёт
   * назначения и увидит, кого именно это касается.
   */
  async remove(id: string, actorUserId: string): Promise<void> {
    await this.findOrFail(id, actorUserId, RbacAuditOperation.Delete);

    const grants = await this.grants.countBy({ permissionId: id });

    if (grants > 0) {
      await this.audit.record({
        actorUserId,
        operation: RbacAuditOperation.Delete,
        entity: RbacAuditEntity.Permission,
        entityId: id,
        statusCode: 409,
        reason: `has_grants:${grants}`,
      });
      throw new ConflictException(
        `Разрешение выдано ролям (назначений: ${grants}). Сначала удалите назначения`,
      );
    }

    await this.permissions.delete({ id });

    await this.audit.record({
      actorUserId,
      operation: RbacAuditOperation.Delete,
      entity: RbacAuditEntity.Permission,
      entityId: id,
      statusCode: 200,
    });

    await this.config.reload(actorUserId);
  }

  /**
   * Убрали действие из разрешения — назначения, где оно перечислено, не
   * ломаются, но перестают что-либо давать: проверка сверяется со списком
   * действий разрешения. Тихо это оставлять нельзя, поэтому пишем в лог.
   */
  private async warnAboutLostActions(
    permission: Permission,
    nextActions: string[],
  ): Promise<void> {
    const kept = new Set(nextActions);
    const removed = permission.actions.filter((action) => !kept.has(action));

    if (removed.length === 0) {
      return;
    }

    const affected = await this.grants.countBy({ permissionId: permission.id });

    this.logger.warn(
      `У разрешения "${permission.name}" убраны действия: ${removed.join(', ')}. ` +
        `Затронуто назначений: ${affected}`,
    );
  }

  private async findOrFail(
    id: string,
    actorUserId: string,
    operation: RbacAuditOperation,
  ): Promise<Permission> {
    const permission = await this.permissions.findOneBy({ id });

    if (!permission) {
      await this.audit.record({
        actorUserId,
        operation,
        entity: RbacAuditEntity.Permission,
        entityId: id,
        statusCode: 404,
        reason: 'not_found',
      });
      throw new NotFoundException('Разрешение не найдено');
    }

    return permission;
  }

  private async conflict(
    error: unknown,
    actorUserId: string,
    entityId: string | null,
  ): Promise<unknown> {
    if ((error as { code?: string }).code !== UNIQUE_VIOLATION) {
      return error;
    }

    await this.audit.record({
      actorUserId,
      operation: entityId
        ? RbacAuditOperation.Update
        : RbacAuditOperation.Create,
      entity: RbacAuditEntity.Permission,
      entityId,
      statusCode: 409,
      reason: 'duplicate_name',
    });

    return new ConflictException('Разрешение с таким названием уже существует');
  }
}
