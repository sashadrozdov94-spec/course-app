import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// Роль администратора. Её проверяет AdminGuard, ею закрыты все /admin/rbac/*.
export const ADMIN_ROLE = 'admin';

// Таблица roles — просто список ролей: admin, manager, support и т.д.
// Связи с пользователями описаны на стороне User (таблица user_roles),
// связи с разрешениями — на стороне Grant. Здесь намеренно ничего лишнего:
// так эта сущность никого не импортирует и круговых импортов не возникает.
@Entity({ name: 'roles' })
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Двух ролей с одинаковым названием быть не может — это требование ТЗ.
  // Уникальный индекс страхует нас от гонки: два одновременных POST
  // не создадут дубль, даже если оба прошли проверку «такой роли нет».
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
