import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { User } from '../../users/entities/user.entity.js';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard.js';

/**
 * Своя наклейка для параметра метода: @CurrentUser() user: User
 *
 * Достаёт пользователя, которого положил в запрос JwtAuthGuard.
 * Работает только на окнах под этим охранником — иначе там будет undefined.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user as User;
  },
);
