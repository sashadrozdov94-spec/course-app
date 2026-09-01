import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { EmailVerification } from '../../auth/entities/email-verification.entity.js';

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

  // null = почта ещё не подтверждена
  @Column({ type: 'timestamptz', nullable: true })
  emailVerifiedAt: Date | null;

  // Все коды подтверждения этого пользователя
  @OneToMany(() => EmailVerification, (verification) => verification.user)
  verifications: Relation<EmailVerification>[];

  // Эти две даты заполняются сами
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
