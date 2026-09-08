import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailModule } from '../mail/mail.module.js';
import { EmailVerification } from './entities/email-verification.entity.js';
import { VerificationService } from './verification.service.js';

/**
 * Коробка с кодами и ссылками подтверждения.
 *
 * Выделена по той же причине, что и TokenModule: коды нужны и коробке auth
 * (регистрация, вход), и коробке users (смена почты). Оставь VerificationService
 * внутри AuthModule — и users пришлось бы импортировать auth, а auth уже
 * импортирует users. Получилось бы кольцо, и Nest не собрал бы приложение.
 *
 * Сама эта коробка не зависит ни от auth, ни от users, поэтому её может
 * импортировать любой.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EmailVerification]), MailModule],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
