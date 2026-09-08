import { HttpException, HttpStatus } from '@nestjs/common';

interface Counter {
  count: number;
  resetAt: number;
}

/**
 * Счётчик «сколько раз за окно» с ключом по номеру аккаунта.
 *
 * Не провайдер Nest, а простой класс: провайдеры создают из него столько
 * счётчиков, сколько нужно, каждый со своими числами. Иначе на каждое
 * ограничение приходилось бы копировать одну и ту же карту со сроками.
 *
 * Почему по аккаунту, а не по адресу клиента, как в RateLimitGuard: за
 * общим NAT все сидят под одним IP и делят чужой бюджет, а сменить адрес
 * атакующему ничего не стоит. Войти же под чужим аккаунтом — нет.
 *
 * Ограничение то же: счётчик живёт в памяти процесса, при нескольких
 * копиях приложения у каждой он свой.
 */
export class AccountRateLimiter {
  private readonly counters = new Map<string, Counter>();
  private readonly windowMs: number;

  constructor(
    private readonly limit: number,
    windowSeconds: number,
    /** Что сказать человеку, когда лимит исчерпан. */
    private readonly message: (retryAfterSeconds: number) => string,
  ) {
    this.windowMs = windowSeconds * 1000;
  }

  /** Засчитать действие. Лимит исчерпан — 429. */
  hit(accountId: string): void {
    const now = Date.now();
    const counter = this.counters.get(accountId);

    if (!counter || counter.resetAt <= now) {
      this.counters.set(accountId, { count: 1, resetAt: now + this.windowMs });
      this.cleanup(now);
      return;
    }

    if (counter.count >= this.limit) {
      const retryAfter = Math.ceil((counter.resetAt - now) / 1000);
      throw new HttpException(
        this.message(retryAfter),
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
