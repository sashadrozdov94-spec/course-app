import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// Таблица permissions — ресурсы и то, что с ними вообще можно делать.
//
// Пример строки: name = 'users', actions = ['read_any', 'block', 'delete'].
// Это словарь допустимого: какие действия каким ролям выданы — решает Grant.
@Entity({ name: 'permissions' })
export class Permission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Идентификатор разрешения, левая часть записи «ресурс@действие»
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  name: string;

  /**
   * Список допустимых действий: ['create', 'update', 'delete'].
   *
   * Хранится настоящим массивом Postgres (text[]), а не строкой через
   * запятую: так значение с запятой внутри не сломает разбор, и по массиву
   * при желании можно искать средствами базы.
   */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  actions: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
