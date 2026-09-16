import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { TokenModule } from '../auth/token.module.js';
import { TransformationsModule } from '../transformations/transformations.module.js';
import { UsersModule } from '../users/users.module.js';
import { ConvertController } from './convert.controller.js';
import { ConvertService } from './convert.service.js';
import { ConversionRunner } from './worker/conversion-runner.service.js';

/**
 * Конвертация файлов между форматами.
 *
 * Сами модули трансформации (converters/) провайдерами не объявлены и в
 * контейнер не попадают — это обычные классы. Так сделано потому, что они
 * выполняются в отдельном потоке, где контейнера нет; заодно их можно
 * проверять юнит-тестами без поднятия приложения.
 */
@Module({
  imports: [
    // История конвертаций общая с изображениями — своей таблицы у модуля
    // нет (см. transformations/)
    TransformationsModule,
    // Охраннику закрытых окон нужны токены и пользователи
    TokenModule,
    UsersModule,
  ],
  controllers: [ConvertController],
  providers: [ConvertService, ConversionRunner, JwtAuthGuard],
})
export class ConvertModule {}
