import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  type UpdateProfileDto,
  updateProfileSchema,
} from './dto/update-profile.dto.js';
import type { ProfileView } from './dto/profile-view.js';
import { userIdParamSchema } from '../shared/user-id.dto.js';
import type { User } from '../entities/user.entity.js';
import { ProfileReadService } from './profile-read.service.js';
// ProfileWriteService импортируется значением, а не через type: Nest
// достаёт зависимости конструктора из метаданных, а type-импорт из
// собранного кода исчезает — контейнер не понял бы, что просить.
import {
  ProfileWriteService,
  type UpdateAck,
} from './profile-write.service.js';

/**
 * Профиль пользователя: посмотреть и изменить. Только это.
 *
 * Смена почты живёт в EmailChangeController, удаление — в
 * DeletionController. Разделены не ради красоты: у тех сценариев
 * есть окна БЕЗ входа (подтверждение по ссылке из письма), а здесь оба
 * окна закрытые, поэтому JwtAuthGuard стоит сразу на классе. Смешав их,
 * пришлось бы вешать охранник на каждый метод по отдельности и следить,
 * чтобы про новый не забыли.
 *
 * Охранники по порядку: сначала ограничитель частоты (он дешёвый и не ходит
 * в базу), потом проверка токена.
 */
@Controller('users')
@UseGuards(RateLimitGuard, JwtAuthGuard)
export class ProfileController {
  constructor(
    private readonly profileRead: ProfileReadService,
    private readonly profileWrite: ProfileWriteService,
  ) {}

  /**
   * GET /users/:userId — посмотреть профиль.
   *
   * Свой — целиком. Чужой — только с правом users.read и только теми
   * полями, которые открыли выданные роли действия (см. PROFILE_FIELD_POLICY).
   *
   * Наклейки @RequirePermission здесь нет намеренно: она закрыла бы окно
   * целиком, и человек не смог бы открыть даже себя. Решение принимается
   * внутри, когда уже видно, свой номер в адресе или чужой.
   */
  @Get(':userId')
  // Общий лимит на чтение профилей с одного адреса. Чужие профили сверх
  // того считаются отдельно и строже — в ProfileReadLimiter.
  @RateLimit({ limit: 60, windowSeconds: 60 })
  findOne(
    // Пайп проверяет, что в адресе действительно номер, а не мусор
    @Param(new ZodValidationPipe(userIdParamSchema))
    params: { userId: string },
    // Кто пришёл — положил в запрос JwtAuthGuard
    @CurrentUser() me: User,
  ): Promise<ProfileView> {
    return this.profileRead.view(me, params.userId);
  }

  /**
   * PATCH /users/:userId — изменить профиль.
   *
   * Свой — только фото. Чужой — с правом users@update, поля по политике
   * PROFILE_UPDATE_POLICY. Почту себе через этот адрес менять нельзя:
   * ответ 403 с подсказкой про сценарий подтверждения.
   *
   * Лимит здесь — по адресу клиента, грубая сеть на всех сразу. Точный
   * лимит на один аккаунт стоит в ProfileWriteLimiter и заведомо ниже
   * (20 за минуту). Если поставить их равными, персональный счётчик не
   * сработает никогда: охранник отрабатывает раньше обработчика, а значит
   * по IP отобьёт первым.
   */
  @Patch(':userId')
  @RateLimit({ limit: 60, windowSeconds: 60 })
  update(
    @Param(new ZodValidationPipe(userIdParamSchema))
    params: { userId: string },
    @Body(new ZodValidationPipe(updateProfileSchema)) patch: UpdateProfileDto,
    @CurrentUser() me: User,
  ): Promise<ProfileView | UpdateAck> {
    return this.profileWrite.update(me, params.userId, patch);
  }
}
