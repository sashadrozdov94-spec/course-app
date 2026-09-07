import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { Permission } from './permission.entity.js';
import { Role } from './role.entity.js';

// Таблица rbac_grants — назначения «роль → разрешение → действия».
//
// Именно эти строки и есть правила доступа. Всё остальное — словари.
@Entity({ name: 'rbac_grants' })
// Одной роли одно и то же разрешение выдаётся один раз: список действий
// внутри назначения и так можно поменять. Индекс уникальный, потому что
// проверки в коде мало — два параллельных POST могут пройти её одновременно.
@Index(['roleId', 'permissionId'], { unique: true })
export class Grant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Удалили роль принудительно — её назначения уходят вместе с ней.
  // Обычное удаление до этого не доходит: сервис сначала отвечает 409.
  @ManyToOne(() => Role, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'roleId' })
  role: Relation<Role>;

  @Column({ type: 'uuid' })
  roleId: string;

  @ManyToOne(() => Permission, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'permissionId' })
  permission: Relation<Permission>;

  @Column({ type: 'uuid' })
  permissionId: string;

  /**
   * Какие действия разрешения выданы этой роли.
   *
   * Пустой массив — особый случай из ТЗ: «доступны все действия разрешения».
   * Он же означает «все будущие тоже»: добавили разрешению новое действие —
   * такое назначение подхватит его само, без правки назначения.
   */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  actions: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
