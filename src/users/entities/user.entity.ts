import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinTable,
  ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { EmailVerification } from '../../auth/entities/email-verification.entity.js';
import { Role } from '../../rbac/entities/role.entity.js';

// Состояние аккаунта
export enum UserStatus {
  PendingVerification = 'pending_verification', // ждёт подтверждения почты
  Active = 'active', // обычный рабочий аккаунт
  Blocked = 'blocked', // заблокирован админом
}

// Таблица users
@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Двух пользователей с одинаковой почтой быть не может
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 320 })
  email: string;

  // Сам пароль не храним — только его зашифрованный отпечаток
  @Column({ type: 'varchar', length: 255, select: false })
  passwordHash: string;

  @Column({
    type: 'enum',
    enum: UserStatus,
    default: UserStatus.PendingVerification,
  })
  status: UserStatus;

  // Ссылка на фото профиля. Сам файл будет лежать в папке на диске —
  // загрузку сделаем на шаге «хранилище файлов».
  @Column({ type: 'varchar', length: 512, nullable: true })
  avatarUrl: string | null;

  // null = почта ещё не подтверждена
  @Column({ type: 'timestamptz', nullable: true })
  emailVerifiedAt: Date | null;

  // Все коды подтверждения этого пользователя
  @OneToMany(() => EmailVerification, (verification) => verification.user)
  verifications: Relation<EmailVerification>[];

  /**
   * Роли пользователя. У одного человека их может быть несколько,
   * и одна роль бывает у многих людей — отсюда отдельная таблица-связка
   * user_roles с двумя колонками.
   *
   * Связь односторонняя: у Role нет обратного поля users. Так задумано —
   * «покажи всех носителей роли» нам нигде не нужно, а лишняя ссылка
   * означала бы круговой импорт между двумя файлами сущностей.
   *
   * Грузится не всегда: обычная выборка пользователя ролей не подтянет.
   * За ними ходят через UsersService.findByIdWithRoles().
   */
  @ManyToMany(() => Role, { cascade: false })
  @JoinTable({
    name: 'user_roles',
    joinColumn: { name: 'userId' },
    inverseJoinColumn: { name: 'roleId' },
  })
  roles: Relation<Role>[];

  // Эти две даты заполняются сами
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
