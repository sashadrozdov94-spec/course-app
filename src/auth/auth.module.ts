import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailModule } from '../mail/mail.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuditService } from './audit.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthAuditLog } from './entities/auth-audit-log.entity.js';
import { EmailVerification } from './entities/email-verification.entity.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PasswordService } from './password.service.js';
import { TokenModule } from './token.module.js';
import { VerificationService } from './verification.service.js';

@Module({
  imports: [
    // Кладовщики для двух таблиц этой коробки
    TypeOrmModule.forFeature([EmailVerification, AuthAuditLog]),
    // Коробка с токенами (её же импортирует users)
    TokenModule,
    // Чужие коробки, которыми пользуемся
    UsersModule,
    SettingsModule,
    MailModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    VerificationService,
    AuditService,
    JwtAuthGuard,
  ],
  // Отдаём наружу то, что понадобится другим коробкам:
  // JwtAuthGuard — чтобы закрывать их окна, TokenService — на всякий случай.
  exports: [PasswordService, JwtAuthGuard],
})
export class AuthModule {}
