import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate-limit';

export interface RateLimitOptions {
  /** Сколько запросов разрешено */
  limit: number;
  /** За какое время, в секундах */
  windowSeconds: number;
}

/**
 * Наклейка для метода контроллера: «не чаще N раз за столько-то секунд».
 * SetMetadata просто прикрепляет к методу данные, которые прочитает охранник.
 */
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);
