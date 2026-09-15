import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Env } from '../config/env.schema.js';
import { AuthAuditLog } from '../auth/entities/auth-audit-log.entity.js';
import { EmailVerification } from '../auth/entities/email-verification.entity.js';
import { FileConversion } from '../convert/entities/file-conversion.entity.js';
import { Grant } from '../rbac/entities/grant.entity.js';
import { Permission } from '../rbac/entities/permission.entity.js';
import { RbacAuditLog } from '../rbac/entities/rbac-audit-log.entity.js';
import { Role } from '../rbac/entities/role.entity.js';
import { AuthSettings } from '../settings/entities/auth-settings.entity.js';
import { User } from '../users/entities/user.entity.js';

// Подключение к базе данных
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // Настройки берём из .env
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres' as const,
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        username: config.get('DB_USERNAME', { infer: true }),
        password: config.get('DB_PASSWORD', { infer: true }),
        database: config.get('DB_NAME', { infer: true }),

        // Список таблиц. Создашь новую — добавь её сюда
        entities: [
          User,
          EmailVerification,
          AuthSettings,
          AuthAuditLog,
          Role,
          Permission,
          Grant,
          RbacAuditLog,
          FileConversion,
        ],

        // Само создаёт и правит таблицы. Только для учёбы, не для боевого сервера
        synchronize: config.get('DB_SYNCHRONIZE', { infer: true }),

        // Показывать в консоли запросы к базе
        logging: config.get('DB_LOGGING', { infer: true }),

        uuidExtension: 'pgcrypto' as const,
      }),
    }),
  ],
})
export class DatabaseModule {}
