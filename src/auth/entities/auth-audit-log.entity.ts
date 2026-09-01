import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Что произошло
export enum AuthAuditEvent {
  RegistrationAttempt = 'registration_attempt',
  VerificationSent = 'verification_sent',
  VerificationConfirmed = 'verification_confirmed',
  LoginAttempt = 'login_attempt',
  PasswordResetRequested = 'password_reset_requested',
}

// Таблица auth_audit_logs — история всех попыток входа и регистрации
@Entity({ name: 'auth_audit_logs' })
@Index(['email', 'createdAt'])
@Index(['ip', 'createdAt'])
export class AuthAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: AuthAuditEvent })
  event: AuthAuditEvent;

  @Column({ type: 'varchar', length: 320, nullable: true })
  email: string | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  // Получилось или нет
  @Column({ type: 'boolean' })
  success: boolean;

  // Почему не получилось, например 'email_taken'
  @Column({ type: 'varchar', length: 64, nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
