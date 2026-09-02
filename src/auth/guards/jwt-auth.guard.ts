import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { User, UserStatus } from '../../users/entities/user.entity.js';
import { UsersService } from '../../users/users.service.js';
import { ACCESS_COOKIE } from '../cookies.js';
import { TokenService } from '../token.service.js';

// Добавляем к объекту запроса поле user, чтобы контроллеры могли его прочитать.
export interface AuthenticatedRequest extends Request {
  user?: User;
}

/**
 * Охранник закрытых окон.
 *
 * Порядок действий ровно как в ТЗ:
 *   1. достать токен из cookie;
 *   2. проверить подпись и срок;
 *   3. найти пользователя по sub;
 *   4. проверить, что он не заблокирован;
 *   5. положить его в запрос, чтобы контроллер знал, кто пришёл.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly tokenService: TokenService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // 1. Токен лежит в cookie, а не в заголовке
    const token = request.cookies?.[ACCESS_COOKIE] as string | undefined;

    if (!token) {
      // В логи пишем причину, но НЕ сам токен
      this.logger.warn(`Запрос без токена: ${request.method} ${request.url}`);
      throw new UnauthorizedException('Требуется вход');
    }

    // 2. Проверяем подпись и срок. Не прошло — внутри бросается 401
    const payload = this.tokenService.verifyAccess(token);

    // 3. Находим пользователя. Токен мог быть выдан удалённому аккаунту
    const user = await this.usersService.findById(payload.sub);

    if (!user) {
      throw new UnauthorizedException('Требуется вход');
    }

    // 4. Заблокированного не пускаем, даже если токен ещё живой
    if (user.status === UserStatus.Blocked) {
      throw new ForbiddenException('Аккаунт заблокирован');
    }

    // 5. Кладём пользователя в запрос — дальше его достанет @CurrentUser()
    request.user = user;
    return true;
  }
}
