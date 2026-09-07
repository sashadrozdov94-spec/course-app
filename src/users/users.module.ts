import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { TokenModule } from '../auth/token.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { User } from './entities/user.entity.js';
import { ProfileAccessService } from './profile-access.service.js';
import { ProfileReadLimiter } from './profile-read.limiter.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [
    // forFeature — «дай мне кладовщика именно для таблицы users»
    TypeOrmModule.forFeature([User]),
    // нужен охраннику закрытых окон, чтобы проверять токены
    TokenModule,
    // проверка прав: «можно ли смотреть чужой профиль»
    RbacModule,
  ],
  controllers: [UsersController],
  // JwtAuthGuard объявлен и здесь: у него две зависимости — TokenService
  // (из TokenModule) и UsersService (наш). Обе на месте, кольца нет.
  providers: [
    UsersService,
    JwtAuthGuard,
    // Кто какой профиль видит и как часто
    ProfileAccessService,
    ProfileReadLimiter,
  ],
  // exports — разрешаем другим коробкам пользоваться UsersService
  exports: [UsersService],
})
export class UsersModule {}
