import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { TokenModule } from '../auth/token.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { UsersModule } from '../users/users.module.js';
import { UserHistoryController } from './admin/user-history.controller.js';
import { Transformation } from './entities/transformation.entity.js';
import { HistoryController } from './history.controller.js';
import { HistoryDownloadService } from './history-download.service.js';
import { HistoryReadService } from './history-read.service.js';
import { HistoryRetentionService } from './history-retention.service.js';
import { HistoryWriteService } from './history-write.service.js';

/**
 * Единая история трансформаций: и запись, и чтение.
 *
 * HistoryWriteService выставлен наружу (exports) — им пользуются модули
 * конвертации файлов и изображений. Так требование п. 1.1 ТЗ о едином
 * хранилище держится устройством, а не договорённостью: писать историю
 * больше некуда, своей таблицы у тех модулей нет.
 *
 * Обратной зависимости нет: этот модуль про конвертацию ничего не знает.
 * Из её модулей сюда приходят готовые строки, а словари форматов берутся
 * из перечислений — файлов без зависимостей (см. dto/list-history.dto.ts).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Transformation]),
    // Охраннику закрытых окон нужны токены и пользователи; UsersModule
    // заодно отвечает на вопрос «а есть ли такой пользователь» для 404
    TokenModule,
    UsersModule,
    // Право на чужую историю проверяет RbacService
    RbacModule,
    // Куда ложатся сохранённые результаты. Какое это хранилище, модуль не
    // знает и знать не должен: он просит FileStorage
    StorageModule,
  ],
  controllers: [HistoryController, UserHistoryController],
  providers: [
    HistoryReadService,
    HistoryWriteService,
    HistoryDownloadService,
    HistoryRetentionService,
    JwtAuthGuard,
  ],
  exports: [HistoryWriteService],
})
export class TransformationsModule {}
