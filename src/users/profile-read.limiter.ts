import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';

interface Counter {
  count: number;
  resetAt: number;
}

/**
 * Ограничитель просмотра ЧУЖИХ профилей (п. 1.4 ТЗ).
 *
 * Зачем отдельно от RateLimitGuard: тот считает запросы по адресу клиента и
 * не различает, свой профиль открыли или чужой. А опасен здесь именно
 * второй случай — так выкачивают базу пользователей. Поэтому считаем по
 * номеру смотрящего: сменить IP просто, а войти под чужим аккаунтом нет.
 *
 * Свой профиль под этот счётчик не попадает: человек волен открывать себя
 * сколько угодно, общий лимит окна его всё равно придержит.
 *
 * Ограничение то же, что и у RateLimitGuard: счётчик живёт в памяти
 * процесса, при нескольких копиях приложения у каждой он свой.
 */
@Injectable()
export class ProfileReadLimiter {
  private readonly counters = new Map<string, Counter>();

  private readonly limit: number;
  private readonly windowMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.limit = config.get('PROFILE_FOREIGN_READ_LIMIT', { infer: true });
    this.windowMs =
      config.get('PROFILE_FOREIGN_READ_WINDOW_SECONDS', { infer: true }) * 1000;
  }

  /** Засчитать просмотр чужого профиля. Лимит исчерпан — 429. */
  hit(viewerUserId: string): void {
    const now = Date.now();
    const counter = this.counters.get(viewerUserId);

    if (!counter || counter.resetAt <= now) {
      this.counters.set(viewerUserId, {
        count: 1,
        resetAt: now + this.windowMs,
      });
      this.cleanup(now);
      return;
    }

    if (counter.count >= this.limit) {
      const retryAfter = Math.ceil((counter.resetAt - now) / 1000);
      throw new HttpException(
        `Слишком много просмотров чужих профилей. Повторите через ${retryAfter} секунд`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    counter.count += 1;
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
