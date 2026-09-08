import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AuthAuditEvent,
  AuthAuditLog,
} from './entities/auth-audit-log.entity.js';

// Кто и откуда пришёл. Заполняет контроллер из HTTP-запроса.
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface AuditRecord extends RequestContext {
  event: AuthAuditEvent;
  success: boolean;
  email?: string | null;
  userId?: string | null;
  reason?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuthAuditLog)
    private readonly repository: Repository<AuthAuditLog>,
  ) {}

  /**
   * Пишет событие в журнал.
   *
   * Внутри try/catch: если запись в журнал упала, это НЕ должно ломать
   * регистрацию пользователя. Журнал важен, но не важнее основного дела.
   */
  async record(data: AuditRecord): Promise<void> {
    try {
      await this.repository.save(
        this.repository.create({
          event: data.event,
          success: data.success,
          email: data.email ?? null,
          userId: data.userId ?? null,
          reason: data.reason ?? null,
          ip: data.ip,
          // Заголовок браузера может быть очень длинным — обрезаем под колонку.
          userAgent: data.userAgent?.slice(0, 512) ?? null,
        }),
      );
    } catch (error) {
      this.logger.error(`Не удалось записать событие в журнал: ${error}`);
    }
  }
}
