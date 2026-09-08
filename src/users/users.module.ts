import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { TokenModule } from '../auth/token.module.js';
import { VerificationModule } from '../auth/verification.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { UserListController } from './admin-list/user-list.controller.js';
import { UserListService } from './admin-list/user-list.service.js';
import { DeletionController } from './deletion/deletion.controller.js';
import { DeletionService } from './deletion/deletion.service.js';
import { EmailChangeController } from './email-change/email-change.controller.js';
import { EmailChangeService } from './email-change/email-change.service.js';
import { User } from './entities/user.entity.js';
import { ProfileController } from './profile/profile.controller.js';
import { ProfileReadService } from './profile/profile-read.service.js';
import { ProfileWriteService } from './profile/profile-write.service.js';
import { UserRateLimits } from './shared/user-rate-limits.service.js';
import { UsersService } from './users.service.js';

/**
 * Пользователи. Внутри — три сценария, у каждого своя папка:
 *
 *   profile/       посмотреть и изменить профиль
 *   email-change/  сменить почту с подтверждением
 *   deletion/      удалить аккаунт
 *
 * В каждой папке лежит ровно то, что относится к сценарию: контроллер,
 * сервис и его схемы. Общее — в shared/: номер пользователя из адреса,
 * названия прав и персональные лимиты, то есть вещи, нужные всем троим.
 *
 * Наружу модуль отдаёт только UsersService: доступ к таблице users нужен
 * коробке auth, а внутренности сценариев — никому.
 */
@Module({
  imports: [
    // forFeature — «дай мне кладовщика именно для таблицы users»
    TypeOrmModule.forFeature([User]),
    // нужен охраннику закрытых окон, чтобы проверять токены
    TokenModule,
    // проверка прав: можно ли смотреть, менять и удалять чужое
    RbacModule,
    // коды подтверждения — для смены почты и удаления
    VerificationModule,
    // настройка «чем подтверждать»: код или ссылка
    SettingsModule,
  ],
  // По контроллеру на сценарий. Все три висят на префиксе /users, но
  // конфликтующих путей между ними нет: открытые подтверждения занимают
  // два сегмента (users/email-change/confirm, users/deletion/confirm), а
  // GET :userId — один, и на два сегмента не натягивается.
  controllers: [
    ProfileController,
    EmailChangeController,
    DeletionController,
    UserListController,
  ],
  providers: [
    UsersService,
    // JwtAuthGuard объявлен и здесь: у него две зависимости — TokenService
    // (из TokenModule) и UsersService (наш). Обе на месте, кольца нет.
    JwtAuthGuard,
    UserRateLimits,
    ProfileReadService,
    ProfileWriteService,
    EmailChangeService,
    DeletionService,
    UserListService,
  ],
  // exports — разрешаем другим коробкам пользоваться UsersService
  exports: [UsersService],
})
export class UsersModule {}
