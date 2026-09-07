import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { type ProfileView, userIdParamSchema } from './dto/user-profile.js';
import type { User } from './entities/user.entity.js';
import { ProfileAccessService } from './profile-access.service.js';

/**
 * Все адреса начинаются с /users. Окна закрытые: нужен вход.
 *
 * Охранники по порядку: сначала ограничитель частоты (он дешёвый и не ходит
 * в базу), потом проверка токена.
 */
@Controller('users')
@UseGuards(RateLimitGuard, JwtAuthGuard)
export class UsersController {
  constructor(private readonly profileAccess: ProfileAccessService) {}

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
    return this.profileAccess.view(me, params.userId);
  }
}
