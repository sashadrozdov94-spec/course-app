import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Что администратор сделал
export enum RbacAuditOperation {
  Create = 'create',
  Update = 'update',
  Delete = 'delete',
  // Не операция администратора, а перезагрузка конфигурации — п. 1.5 ТЗ
  // требует писать в журнал и её тоже.
  ReloadConfig = 'reload_config',
  // Проверка доступа охранником. Пишется только когда она закончилась
  // отказом: успешных проверок столько же, сколько запросов, и журнал
  // из них состоял бы целиком.
  Check = 'check',
}

// Над чем
export enum RbacAuditEntity {
  Role = 'role',
  Permission = 'permission',
  Grant = 'grant',
  Config = 'config',
  // Отказ в доступе относится не к строке таблицы, а к самой попытке
  Access = 'access',
}

// Таблица rbac_audit_logs — история изменений правил доступа.
//
// Отдельно от auth_audit_logs: там события про вход и регистрацию с почтой
// и IP, здесь — про правила. Смешивать их в одной таблице значило бы
// иметь колонки, половина из которых всегда пустая.
@Entity({ name: 'rbac_audit_logs' })
@Index(['actorUserId', 'createdAt'])
export class RbacAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Кто менял. null — значит изменение сделало само приложение
  // (например, перезагрузка конфигурации при старте).
  @Column({ type: 'uuid', nullable: true })
  actorUserId: string | null;

  @Column({ type: 'enum', enum: RbacAuditOperation })
  operation: RbacAuditOperation;

  @Column({ type: 'enum', enum: RbacAuditEntity })
  entity: RbacAuditEntity;

  // Номер затронутой строки. null для перезагрузки конфигурации.
  @Column({ type: 'uuid', nullable: true })
  entityId: string | null;

  // Код ответа, который получил администратор: 200, 201, 403, 409
  @Column({ type: 'int' })
  statusCode: number;

  // Короткое пояснение: 'duplicate_name', 'has_grants' и т.п.
  @Column({ type: 'varchar', length: 128, nullable: true })
  reason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
