import type { CookieOptions, Response } from 'express';
import type { TokenPair } from './token.service.js';

// Только то, что нужно cookies, а не весь конфиг приложения.
export interface CookieSettings {
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
}

// Имена cookies. В одном месте, чтобы не разъехались.
export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';

// Сколько живут cookies. Держим синхронно со сроком жизни токенов.
const ACCESS_MAX_AGE_MS = 15 * 60 * 1000; // 15 минут
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

/**
 * Общие настройки cookie для токенов.
 *
 * httpOnly: true  — JavaScript на странице НЕ может прочитать cookie.
 *                   Главная защита: если на сайт попадёт чужой скрипт (XSS),
 *                   он не сможет украсть токен.
 * secure:   true  — cookie передаётся только по HTTPS. Локально (http)
 *                   должно быть false, иначе браузер её просто не сохранит.
 * sameSite: 'lax' — cookie не отправляется на чужие сайты. Защита от CSRF:
 *                   стороннему сайту не удастся сделать запрос от твоего имени.
 * path:     '/'   — cookie действует на все адреса приложения.
 */
function baseOptions(settings: CookieSettings): CookieOptions {
  return {
    httpOnly: true,
    secure: settings.secure,
    sameSite: settings.sameSite,
    path: '/',
  };
}

/** Положить оба токена в cookies. */
export function setAuthCookies(
  response: Response,
  tokens: TokenPair,
  settings: CookieSettings,
): void {
  const options = baseOptions(settings);

  response.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...options,
    maxAge: ACCESS_MAX_AGE_MS,
  });

  response.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...options,
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

/**
 * Убрать токены из cookies — это и есть выход из системы.
 *
 * По ТЗ refresh-токены на сервере не хранятся, поэтому «отозвать» уже
 * выданный токен нельзя. Выход = очистка cookies у этого клиента.
 */
export function clearAuthCookies(
  response: Response,
  settings: CookieSettings,
): void {
  const options = baseOptions(settings);
  response.clearCookie(ACCESS_COOKIE, options);
  response.clearCookie(REFRESH_COOKIE, options);
}
