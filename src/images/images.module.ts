import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { TokenModule } from '../auth/token.module.js';
import { TransformationsModule } from '../transformations/transformations.module.js';
import { UsersModule } from '../users/users.module.js';
import { ImagesController } from './images.controller.js';
import { ImagesService } from './images.service.js';

/**
 * Трансформация изображений между PNG, JPEG и SVG.
 *
 * Сами направления (converters/) провайдерами не объявлены и в контейнер
 * не попадают — это обычные классы без зависимостей. Так их можно
 * проверять юнит-тестами, не поднимая приложение, а настройки приходят к
 * ним параметром: конвертер не должен знать, откуда взялся потолок
 * размеров, — только какой он.
 *
 * Своей таблицы в базе у модуля нет и быть не должно: история всех
 * трансформаций — и файлов, и картинок — лежит в одном месте
 * (transformations/), как требует ТЗ про её просмотр. Сюда приходит
 * готовый писатель истории, а куда он пишет, модулю знать незачем.
 */
@Module({
  imports: [
    // История трансформаций общая с конвертацией файлов
    TransformationsModule,
    // Охраннику закрытых окон нужны токены и пользователи
    TokenModule,
    UsersModule,
  ],
  controllers: [ImagesController],
  providers: [ImagesService, JwtAuthGuard],
})
export class ImagesModule {}
