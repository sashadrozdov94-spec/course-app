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
  EmailChange = 'email_change',
  AccountDeletion = 'account_deletion',
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

  /**
   * Новый адрес — только для purpose = email_change.
   *
   * Хранить его обязательно: между «запросил смену» и «подтвердил» проходит
   * до десяти минут, и к моменту подтверждения знать, на какой адрес
   * человек переезжал, больше неоткуда. Письмо с кодом уходит именно сюда,
   * а не на текущую почту — иначе подтверждение ничего не доказывало бы.
   */
  @Column({ type: 'varchar', length: 320, nullable: true })
  newEmail: string | null;

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
