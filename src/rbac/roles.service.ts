import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { CreateRoleDto, UpdateRoleDto } from './dto/role.dto.js';
import { type RoleView, toRoleView } from './dto/role.dto.js';
import { Grant } from './entities/grant.entity.js';
import {
  RbacAuditEntity,
  RbacAuditOperation,
} from './entities/rbac-audit-log.entity.js';
import { ADMIN_ROLE, Role } from './entities/role.entity.js';
import { RbacAuditService } from './rbac-audit.service.js';
import { RbacConfigService } from './rbac-config.service.js';

// Код ошибки Postgres «нарушено уникальное ограничение».
// Проверка «а нет ли уже такого названия» отдельным запросом не спасает от
// гонки: два запроса могут пройти её одновременно. Настоящую уникальность
// держит индекс в базе, а мы переводим его ошибку в понятный 409.
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role)
    private readonly roles: Repository<Role>,
    @InjectRepository(Grant)
    private readonly grants: Repository<Grant>,
    private readonly audit: RbacAuditService,
    private readonly config: RbacConfigService,
  ) {}

  async findAll(): Promise<RoleView[]> {
    const roles = await this.roles.find({ order: { name: 'ASC' } });
    return roles.map(toRoleView);
  }

  async create(dto: CreateRoleDto, actorUserId: string): Promise<RoleView> {
    const role = this.roles.create({
      id: dto.id,
      name: dto.name,
      description: dto.description ?? null,
    });

    let saved: Role;

    try {
      saved = await this.roles.save(role);
    } catch (error) {
      throw await this.conflict(error, actorUserId, null, 'duplicate_name');
    }

    await this.audit.record({
      actorUserId,
      operation: RbacAuditOperation.Create,
      entity: RbacAuditEntity.Role,
      entityId: saved.id,
      statusCode: 201,
    });

    // Новая роль ещё ничего не даёт, но конфигурация должна знать её имя
    await this.config.reload(actorUserId);

    return toRoleView(saved);
  }

  async update(
    id: string,
    dto: UpdateRoleDto,
    actorUserId: string,
  ): Promise<RoleView> {
    const role = await this.findOrFail(
      id,
      actorUserId,
      RbacAuditOperation.Update,
    );

    // Роль admin — единственный вход в раздел управления правами.
    // Переименовали её — и администраторов в системе не осталось.
    if (role.name === ADMIN_ROLE && dto.name && dto.name !== ADMIN_ROLE) {
      await this.audit.record({
        actorUserId,
        operation: RbacAuditOperation.Update,
        entity: RbacAuditEntity.Role,
        entityId: id,
        statusCode: 409,
        reason: 'protected_role',
      });
      throw new ConflictException('Роль admin нельзя переименовать');
    }

    if (dto.name !== undefined) {
      role.name = dto.name;
    }

    if (dto.description !== undefined) {
      role.description = dto.description;
    }

    let saved: Role;

    try {
      saved = await this.roles.save(role);
    } catch (error) {
      throw await this.conflict(error, actorUserId, id, 'duplicate_name');
    }

    await this.audit.record({
      actorUserId,
      operation: RbacAuditOperation.Update,
      entity: RbacAuditEntity.Role,
      entityId: id,
      statusCode: 200,
    });

    await this.config.reload(actorUserId);

    return toRoleView(saved);
  }

  /**
   * Удаление роли.
   *
   * force = false: есть назначения — 409, ничего не трогаем.
   * force = true: удаляем вместе с назначениями (за каскад отвечает
   * onDelete: 'CASCADE' у Grant.role).
   *
   * Так решён вопрос ТЗ «запрещать или удалять каскадно»: выбирает тот, кто
   * удаляет, и делает это осознанно. Молчаливого каскада, который тихо
   * снимает права с половины системы, здесь нет.
   */
  async remove(id: string, force: boolean, actorUserId: string): Promise<void> {
    const role = await this.findOrFail(
      id,
      actorUserId,
      RbacAuditOperation.Delete,
    );

    if (role.name === ADMIN_ROLE) {
      await this.audit.record({
        actorUserId,
        operation: RbacAuditOperation.Delete,
        entity: RbacAuditEntity.Role,
        entityId: id,
        statusCode: 409,
        reason: 'protected_role',
      });
      throw new ConflictException('Роль admin удалить нельзя');
    }

    const grants = await this.grants.countBy({ roleId: id });

    if (grants > 0 && !force) {
      await this.audit.record({
        actorUserId,
        operation: RbacAuditOperation.Delete,
        entity: RbacAuditEntity.Role,
        entityId: id,
        statusCode: 409,
        reason: `has_grants:${grants}`,
      });
      throw new ConflictException(
        `У роли есть назначения (${grants}). Удалите их или повторите запрос с ?force=true`,
      );
    }

    await this.roles.delete({ id });

    await this.audit.record({
      actorUserId,
      operation: RbacAuditOperation.Delete,
      entity: RbacAuditEntity.Role,
      entityId: id,
      statusCode: 200,
      reason: grants > 0 ? `cascade:${grants}` : null,
    });

    await this.config.reload(actorUserId);
  }

  // Роль есть — вернём. Нет — 404 и запись в журнал.
  private async findOrFail(
    id: string,
    actorUserId: string,
    operation: RbacAuditOperation,
  ): Promise<Role> {
    const role = await this.roles.findOneBy({ id });

    if (!role) {
      await this.audit.record({
        actorUserId,
        operation,
        entity: RbacAuditEntity.Role,
        entityId: id,
        statusCode: 404,
        reason: 'not_found',
      });
      throw new NotFoundException('Роль не найдена');
    }

    return role;
  }

  // Ошибка уникальности → 409, любая другая — пусть летит как есть
  private async conflict(
    error: unknown,
    actorUserId: string,
    entityId: string | null,
    reason: string,
  ): Promise<unknown> {
    if ((error as { code?: string }).code !== UNIQUE_VIOLATION) {
      return error;
    }

    await this.audit.record({
      actorUserId,
      operation: entityId
        ? RbacAuditOperation.Update
        : RbacAuditOperation.Create,
      entity: RbacAuditEntity.Role,
      entityId,
      statusCode: 409,
      reason,
    });

    return new ConflictException('Роль с таким названием уже существует');
  }
}
