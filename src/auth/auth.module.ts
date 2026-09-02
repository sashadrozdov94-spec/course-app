import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
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
import { TokenService } from './token.service.js';
import { VerificationService } from './verification.service.js';

@Module({
  imports: [
    // Кладовщики для двух таблиц этой коробки
    TypeOrmModule.forFeature([EmailVerification, AuthAuditLog]),
    // Секреты и сроки задаём в TokenService при каждой подписи,
    // поэтому здесь регистрируем модуль без общих настроек.
    JwtModule.register({}),
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
    TokenService,
    JwtAuthGuard,
  ],
  // Отдаём наружу то, что понадобится другим коробкам:
  // JwtAuthGuard — чтобы закрывать их окна, TokenService — на всякий случай.
  exports: [PasswordService, TokenService, JwtAuthGuard],
})
export class AuthModule {}
