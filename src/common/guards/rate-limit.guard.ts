import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  RATE_LIMIT_KEY,
  type RateLimitOptions,
} from '../decorators/rate-limit.decorator.js';

interface Counter {
  count: number;
  resetAt: number;
}

/**
 * Ограничитель частоты запросов.
 *
 * Считает запросы по адресу клиента в памяти приложения.
 * Ограничение: при нескольких копиях приложения у каждой свой счётчик 
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly counters = new Map<string, Counter>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Читаем наклейку @RateLimit с метода. Нет наклейки — пропускаем всех.
    const options = this.reflector.get<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );

    if (!options) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    // Ключ: адрес клиента + конкретное окно. У каждого окна свой счётчик.
    const key = `${request.ip ?? 'unknown'}:${context.getHandler().name}`;
    const now = Date.now();

    const counter = this.counters.get(key);

    // Счётчика нет или его время вышло — начинаем новое окно
    if (!counter || counter.resetAt <= now) {
      this.counters.set(key, {
        count: 1,
        resetAt: now + options.windowSeconds * 1000,
      });
      this.cleanup(now);
      return true;
    }

    if (counter.count >= options.limit) {
      const retryAfter = Math.ceil((counter.resetAt - now) / 1000);
      throw new HttpException(
        `Слишком много запросов. Повторите через ${retryAfter} секунд`,
        HttpStatus.TOO_MANY_REQUESTS, // 429
      );
    }

    counter.count += 1;
    return true;
  }

  /** Выбрасываем просроченные счётчики, чтобы память не росла бесконечно. */
  private cleanup(now: number): void {
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) {
        this.counters.delete(key);
      }
    }
  }
}
