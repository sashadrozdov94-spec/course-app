import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../../auth/guards/jwt-auth.guard.js';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator.js';
import {
  RbacAuditEntity,
  RbacAuditOperation,
} from '../entities/rbac-audit-log.entity.js';
import { RbacAuditService } from '../rbac-audit.service.js';
import { parsePermissionRef, RbacService } from '../rbac.service.js';

/**
 * Охранник прав. Ставится ПОСЛЕ JwtAuthGuard:
 *
 *   @UseGuards(JwtAuthGuard, PermissionsGuard)
 *
 * Порядок важен — этот охранник берёт пользователя из запроса, а кладёт
 * его туда JwtAuthGuard. Nest вызывает охранников слева направо.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rbac: RbacService,
    private readonly audit: RbacAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Наклейку ищем сперва на методе, потом на классе контроллера:
    // так право можно повесить сразу на весь контроллер.
    const reference = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Наклейки нет — этому окну права не нужны
    if (!reference) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      // Значит, забыли поставить JwtAuthGuard перед этим охранником
      this.logger.error(
        `Проверка права "${reference}" без аутентификации: ${request.method} ${request.url}`,
      );
      throw new UnauthorizedException('Требуется вход');
    }

    const { permission, action } = parsePermissionRef(reference);
    const allowed = await this.rbac.can(user, permission, action);

    if (!allowed) {
      this.logger.warn(
        `Отказ: пользователю ${user.id} не хватает права "${reference}"`,
      );

      // Отказ пишем в таблицу — п. 1.5 ТЗ про результат 403.
      // Успешные проверки не пишем: их столько же, сколько запросов.
      await this.audit.record({
        actorUserId: user.id,
        operation: RbacAuditOperation.Check,
        entity: RbacAuditEntity.Access,
        statusCode: 403,
        reason: reference.slice(0, 128),
      });

      throw new ForbiddenException('Недостаточно прав');
    }

    return true;
  }
}
