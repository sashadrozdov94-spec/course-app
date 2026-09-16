import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { validateEnv } from './config/env.schema.js';
import { ConvertModule } from './convert/convert.module.js';
import { DatabaseModule } from './database/database.module.js';
import { ImagesModule } from './images/images.module.js';
import { RbacAdminModule } from './rbac/rbac-admin.module.js';
import { StorageModule } from './storage/storage.module.js';
import { TransformationsModule } from './transformations/transformations.module.js';

@Module({
  imports: [
    /**
     * Читает .env и валидирует его нашей zod-схемой.
     *
     * isGlobal: true — ConfigService станет доступен в любом модуле без
     * повторного импорта ConfigModule. Для конфига это оправдано: он нужен
     * почти везде и не хранит состояния.
     *
     * ConfigModule стоит первым, потому что DatabaseModule читает конфиг
     * при старте: Nest инициализирует модули в порядке зависимостей.
     */
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
      // Кэшировать значения в памяти: обращение к process.env медленное.
      cache: true,
    }),
    DatabaseModule,
    AuthModule,
    // Раздел /admin/rbac/*. Само ядро RBAC приезжает сюда вместе с ним
    // и с UsersModule, поэтому отдельно RbacModule здесь не нужен.
    RbacAdminModule,
    // Хранилище файлов. Стоит перед историей: она в него пишет
    StorageModule,
    // Единая история трансформаций. Стоит перед модулями конвертации:
    // они пишут в неё, а не наоборот
    TransformationsModule,
    ConvertModule,
    ImagesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
