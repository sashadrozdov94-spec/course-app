import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { VerificationChannel } from '../../auth/entities/email-verification.entity.js';

// Настройки, которые включает и выключает администратор.
// В этой таблице всегда только одна строка (id = 1).
@Entity({ name: 'auth_settings' })
export class AuthSettings {
  @PrimaryColumn({ type: 'int' })
  id: number;

  // Спрашивать подтверждение почты при регистрации?
  @Column({ type: 'boolean', default: false })
  requireVerificationOnRegistration: boolean;

  // ...при восстановлении пароля?
  @Column({ type: 'boolean', default: true })
  requireVerificationOnPasswordReset: boolean;

  // ...при входе?
  @Column({ type: 'boolean', default: false })
  requireVerificationOnLogin: boolean;

  // Чем подтверждать: кодом или ссылкой
  @Column({
    type: 'enum',
    enum: VerificationChannel,
    default: VerificationChannel.Otp,
  })
  verificationChannel: VerificationChannel;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
