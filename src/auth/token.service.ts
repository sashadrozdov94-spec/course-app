import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.schema.js';

// Что лежит внутри токена. Названия полей sub/exp/iat — стандарт JWT.
export interface TokenPayload {
  /** subject — кому выдан токен, у нас id пользователя */
  sub: string;
  email: string;
  /** номер самого токена — у каждой выдачи свой */
  jti?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Выдача и проверка токенов.
 *
 * Два разных токена и два РАЗНЫХ секрета:
 *   access  — короткий (15 минут), им подтверждают каждый запрос;
 *   refresh — долгий (30 дней), нужен только чтобы получить новый access.
 *
 * Разные секреты означают, что refresh нельзя подсунуть вместо access:
 * подпись не сойдётся.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async issuePair(payload: TokenPayload): Promise<TokenPair> {
    // Свой номер у каждого токена.
    // Без него две выдачи в одну и ту же секунду дали бы одинаковые
    // токены: время внутри JWT хранится в секундах, а остальное совпадает.
    // ТЗ требует при каждом обновлении выдавать именно новую пару.
    const access = { ...payload, jti: randomUUID() };
    const refresh = { ...payload, jti: randomUUID() };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(access, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
      }),
      this.jwtService.signAsync(refresh, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        expiresIn: this.config.get('JWT_REFRESH_TTL', { infer: true }),
      }),
    ]);

    return { accessToken, refreshToken };
  }

  /** Проверить access-токен. Внутри проверяется и подпись, и срок. */
  verifyAccess(token: string): TokenPayload {
    return this.verify(
      token,
      this.config.get('JWT_ACCESS_SECRET', { infer: true }),
    );
  }

  /** Проверить refresh-токен. */
  verifyRefresh(token: string): TokenPayload {
    return this.verify(
      token,
      this.config.get('JWT_REFRESH_SECRET', { infer: true }),
    );
  }

  private verify(token: string, secret: string): TokenPayload {
    try {
      return this.jwtService.verify<TokenPayload>(token, { secret });
    } catch {
      // Наружу не рассказываем, что именно не так: подпись, срок или формат.
      // Клиенту достаточно знать, что пропуск не годится.
      throw new UnauthorizedException('Требуется вход');
    }
  }
}
