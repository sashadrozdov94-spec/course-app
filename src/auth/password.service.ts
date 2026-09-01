import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { compare, hash } from 'bcryptjs';
import type { Env } from '../config/env.schema.js';

// Всё, что связано с паролями. Больше нигде в приложении bcrypt не появляется.
@Injectable()
export class PasswordService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  // Делает из пароля отпечаток. Обратно не разворачивается.
  hash(plainPassword: string): Promise<string> {
    const rounds = this.config.get('BCRYPT_ROUNDS', { infer: true });
    return hash(plainPassword, rounds);
  }

  // Проверяет, соответствует ли пароль отпечатку.
  verify(plainPassword: string, passwordHash: string): Promise<boolean> {
    return compare(plainPassword, passwordHash);
  }
}
