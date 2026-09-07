import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RbacAuditEntity,
  RbacAuditLog,
  RbacAuditOperation,
} from './entities/rbac-audit-log.entity.js';

export interface RbacAuditRecord {
  actorUserId: string | null;
  operation: RbacAuditOperation;
  entity: RbacAuditEntity;
  entityId?: string | null;
  statusCode: number;
  reason?: string | null;
}

/**
 * Журнал изменений правил доступа (п. 1.5 ТЗ).
 *
 * Пишем и удачные операции, и отказы: «кто-то трижды пытался удалить
 * роль admin и получил 403» — это ровно то, ради чего журнал и заводят.
 */
@Injectable()
export class RbacAuditService {
  private readonly logger = new Logger(RbacAuditService.name);

  constructor(
    @InjectRepository(RbacAuditLog)
    private readonly repository: Repository<RbacAuditLog>,
  ) {}

  /**
   * Как и в AuditService: внутри try/catch. Упавшая запись в журнал не
   * должна отменять уже сделанное изменение правил.
   */
  async record(data: RbacAuditRecord): Promise<void> {
    const target = data.entityId ? ` ${data.entityId}` : '';
    const why = data.reason ? ` (${data.reason})` : '';
    const actor = data.actorUserId ?? 'система';

    // В консоль пишем всегда — она под рукой, когда база недоступна
    this.logger.log(
      `rbac ${data.operation} ${data.entity}${target} → ${data.statusCode}${why} актор=${actor}`,
    );

    try {
      await this.repository.save(
        this.repository.create({
          actorUserId: data.actorUserId,
          operation: data.operation,
          entity: data.entity,
          entityId: data.entityId ?? null,
          statusCode: data.statusCode,
          reason: data.reason ?? null,
        }),
      );
    } catch (error) {
      this.logger.error(`Не удалось записать событие в журнал RBAC: ${error}`);
    }
  }
}
