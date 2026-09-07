import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import type { CreateGrantDto, UpdateGrantDto } from './dto/grant.dto.js';
import { type GrantView, toGrantView } from './dto/grant.dto.js';
import { Grant } from './entities/grant.entity.js';
import { Permission } from './entities/permission.entity.js';
import {
  RbacAuditEntity,
  RbacAuditOperation,
} from './entities/rbac-audit-log.entity.js';
import { Role } from './entities/role.entity.js';
import { RbacAuditService } from './rbac-audit.service.js';
import { RbacConfigService } from './rbac-config.service.js';

const UNIQUE_VIOLATION = '23505';

/**
 * Назначения — единственная таблица, которая на самом деле раздаёт права.
 * Поэтому здесь больше всего проверок: ссылки должны вести на существующие
 * строки, а действия — входить в список действий разрешения.
 */
@Injectable()
export class GrantsService {
  constructor(
    @InjectRepository(Grant)
    private readonly grants: Repository<Grant>,
    @InjectRepository(Role)
    private readonly roles: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    private readonly audit: RbacAuditService,
    private readonly config: RbacConfigService,
  ) {}

  async findAll(): Promise<GrantView[]> {
    const grants = await this.grants.find({ order: { createdAt: 'ASC' } });
    return grants.map(toGrantView);
  }

  async create(dto: CreateGrantDto, actorUserId: string): Promise<GrantView> {
    await this.ensureRoleExists(
      dto.roleId,
      actorUserId,
      RbacAuditOperation.Create,
    );

    const permission = await this.ensurePermissionExists(
      dto.permissionId,
      actorUserId,
      RbacAuditOperation.Create,
    );

    const actions = dto.actions ?? [];
    this.ensureActionsAllowed(actions, permission);

    const grant = this.grants.create({
      id: dto.id,
      roleId: dto.roleId,
      permissionId: dto.permissionId,
      actions,
    });

    let saved: Grant;

    try {
      saved = await this.grants.save(grant);
    } catch (error) {
      throw await this.conflict(error, actorUserId, null);
    }

    await this.audit.record({
      actorUserId,
      operation: RbacAuditOperation.Create,
      entity: RbacAuditEntity.Grant,
      entityId: saved.id,
      statusCode: 201,
    });

    // Сценарий 2 из ТЗ: правила изменились — конфигурация перечитана,
    // новые права работают со следующего же запроса, без перезапуска.
    await this.config.reload(actorUserId);

    return toGrantView(saved);
  }

  async update(
    id: string,
    dto: UpdateGrantDto,
    actorUserId: string,
  ): Promise<GrantView> {
    const grant = await this.findOrFail(
      id,
      actorUserId,
      RbacAuditOperation.Update,
    );

    // Считаем, какими роль и разрешение станут после изменения
    const roleId = dto.roleId ?? grant.roleId;
    const permissionId = dto.permissionId ?? grant.permissionId;

    if (dto.roleId) {
      await this.ensureRoleExists(
        roleId,
        actorUserId,
        RbacAuditOperation.Update,
      );
    }

    const permission = await this.ensurePermissionExists(
      permissionId,
      actorUserId,
      RbacAuditOperation.Update,
    );

    // Действия проверяем против будущего разрешения, а не прежнего:
    // сменили разрешение — старые действия могут в нём и не значиться,
    // поэтому при смене разрешения без явных действий берём пустой список
    // («все действия»), а не тащим за собой прежний.
    const actions = dto.actions ?? (dto.permissionId ? [] : grant.actions);
    this.ensureActionsAllowed(actions, permission);

    // Дубликат ищем среди чужих строк: сама себе эта строка не помеха
    const duplicate = await this.grants.findOneBy({
      roleId,
      permissionId,
      id: Not(id),
    });

    if (duplicate) {
      await this.audit.record({
        actorUserId,
        operation: RbacAuditOperation.Update,
        entity: RbacAuditEntity.Grant,
        entityId: id,
        statusCode: 409,
        reason: 'duplicate_grant',
      });
      throw new ConflictException(
        'У этой роли уже есть назначение с таким разрешением',
      );
    }

    grant.roleId = roleId;
    grant.permissionId = permissionId;
    grant.actions = actions;

    let saved: Grant;

    try {
      saved = await this.grants.save(grant);
    } catch (error) {
      throw await this.conflict(error, actorUserId, id);
    }

    await this.audit.record({
      actorUserId,
      operation: RbacAuditOperation.Update,
      entity: RbacAuditEntity.Grant,
      entityId: id,
      statusCode: 200,
    });

    await this.config.reload(actorUserId);

    return toGrantView(saved);
  }

  /** Назначение — сама связь, зависимых строк у него нет: 409 неоткуда взяться. */
  async remove(id: string, actorUserId: string): Promise<void> {
    await this.findOrFail(id, actorUserId, RbacAuditOperation.Delete);

    await this.grants.delete({ id });

    await this.audit.record({
      actorUserId,
      operation: RbacAuditOperation.Delete,
      entity: RbacAuditEntity.Grant,
      entityId: id,
      statusCode: 200,
    });

    await this.config.reload(actorUserId);
  }

  /**
   * Выдать можно только то, что у разрешения объявлено.
   *
   * Иначе в базе завелись бы назначения, которые выглядят выданными, но
   * ничего не дают: проверка доступа сверяется со списком действий
   * разрешения и такое действие отбросит.
   */
  private ensureActionsAllowed(
    actions: string[],
    permission: Permission,
  ): void {
    const allowed = new Set(permission.actions);
    const unknown = actions.filter((action) => !allowed.has(action));

    if (unknown.length > 0) {
      throw new BadRequestException(
        `Разрешение "${permission.name}" не поддерживает действия: ` +
          `${unknown.join(', ')}. Допустимые: ${permission.actions.join(', ')}`,
      );
    }
  }

  private async ensureRoleExists(
    roleId: string,
    actorUserId: string,
    operation: RbacAuditOperation,
  ): Promise<Role> {
    const role = await this.roles.findOneBy({ id: roleId });

    if (!role) {
      await this.audit.record({
        actorUserId,
        operation,
        entity: RbacAuditEntity.Grant,
        entityId: null,
        statusCode: 404,
        reason: 'role_not_found',
      });
      throw new NotFoundException('Роль не найдена');
    }

    return role;
  }

  private async ensurePermissionExists(
    permissionId: string,
    actorUserId: string,
    operation: RbacAuditOperation,
  ): Promise<Permission> {
    const permission = await this.permissions.findOneBy({ id: permissionId });

    if (!permission) {
      await this.audit.record({
        actorUserId,
        operation,
        entity: RbacAuditEntity.Grant,
        entityId: null,
        statusCode: 404,
        reason: 'permission_not_found',
      });
      throw new NotFoundException('Разрешение не найдено');
    }

    return permission;
  }

  private async findOrFail(
    id: string,
    actorUserId: string,
    operation: RbacAuditOperation,
  ): Promise<Grant> {
    const grant = await this.grants.findOneBy({ id });

    if (!grant) {
      await this.audit.record({
        actorUserId,
        operation,
        entity: RbacAuditEntity.Grant,
        entityId: id,
        statusCode: 404,
        reason: 'not_found',
      });
      throw new NotFoundException('Назначение не найдено');
    }

    return grant;
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
      entity: RbacAuditEntity.Grant,
      entityId,
      statusCode: 409,
      reason: 'duplicate_grant',
    });

    return new ConflictException(
      'У этой роли уже есть назначение с таким разрешением',
    );
  }
}
