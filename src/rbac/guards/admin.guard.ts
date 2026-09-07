import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../../auth/guards/jwt-auth.guard.js';
import {
  RbacAuditEntity,
  RbacAuditOperation,
} from '../entities/rbac-audit-log.entity.js';
import { RbacAuditService } from '../rbac-audit.service.js';
import { RbacService } from '../rbac.service.js';

/**
 * Охранник раздела /admin/rbac/*: пускает только носителей роли admin.
 *
 * Почему проверка по роли, а не через сам RBAC: правами управляет тот, кто
 * ими же и распоряжается. Выдай себе через API право «rbac@manage» — и
 * закрыть эту дверь снаружи станет нечем. Роль admin назначается только в
 * обход API, поэтому её нельзя получить, эксплуатируя API.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(
    private readonly rbac: RbacService,
    private readonly audit: RbacAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Требуется вход');
    }

    if (!this.rbac.isAdmin(user)) {
      this.logger.warn(
        `Отказ: пользователь ${user.id} не администратор — ${request.method} ${request.url}`,
      );

      // Отказ идёт и в таблицу: п. 1.5 ТЗ требует писать результат 403,
      // а не только 200 и 409. Из консоли историю попыток не соберёшь.
      await this.audit.record({
        actorUserId: user.id,
        operation: RbacAuditOperation.Check,
        entity: RbacAuditEntity.Access,
        statusCode: 403,
        reason: `admin_required:${request.method} ${request.url}`.slice(0, 128),
      });

      throw new ForbiddenException('Требуются права администратора');
    }

    return true;
  }
}
