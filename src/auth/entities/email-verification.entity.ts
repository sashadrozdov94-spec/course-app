import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { User } from '../../users/entities/user.entity.js';

// Зачем выдан код
export enum VerificationPurpose {
  Registration = 'registration',
  Login = 'login',
}

// Чем подтверждаем: коротким кодом или ссылкой из письма
export enum VerificationChannel {
  Otp = 'otp',
  MagicLink = 'magic_link',
}

// Таблица email_verifications — одноразовые коды и ссылки
@Entity({ name: 'email_verifications' })
@Index(['userId', 'purpose'])
export class EmailVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Кому выдан код. Удалим пользователя — его коды удалятся сами
  @ManyToOne(() => User, (user) => user.verifications, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: VerificationPurpose })
  purpose: VerificationPurpose;

  @Column({ type: 'enum', enum: VerificationChannel })
  channel: VerificationChannel;

  // Сам код не храним — только его отпечаток
  @Column({ type: 'varchar', length: 64 })
  secretHash: string;

  // После этого времени код не работает
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  // Сколько раз уже вводили код неправильно
  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int' })
  maxAttempts: number;

  // null = кодом ещё не воспользовались
  @Column({ type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  // Когда последний раз отправляли письмо — чтобы не слать чаще раза в минуту
  @Column({ type: 'timestamptz' })
  lastSentAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
