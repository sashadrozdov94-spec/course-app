import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as z from 'zod';
import { AccountRateLimiter } from './account-rate-limiter.js';
import {
  RATE_LIMIT_KEY,
  RateLimit,
} from './decorators/rate-limit.decorator.js';
import { RateLimitGuard } from './guards/rate-limit.guard.js';
import { ApiZodQuery, zodToOpenApi } from './openapi/zod-openapi.js';
import { ZodValidationPipe } from './pipes/zod-validation.pipe.js';
import { isUniqueViolation } from './postgres-errors.js';

describe('Перевод ошибок Postgres', () => {
  it('узнаёт нарушение уникальности от драйвера', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('узнаёт его же, завёрнутое TypeORM', () => {
    // repository.save отдаёт ошибку драйвера как есть, а часть путей
    // TypeORM заворачивает её и кладёт оригинал в driverError
    expect(isUniqueViolation({ driverError: { code: '23505' } })).toBe(true);
  });

  it('не принимает за неё другие ошибки базы', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('сеть отвалилась'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe('Проверка запроса схемой', () => {
  const schema = z.object({
    email: z.email('Похоже, это не адрес почты'),
    age: z.coerce.number().int().min(18, 'Только совершеннолетним'),
  });
  const pipe = new ZodValidationPipe(schema);

  it('пропускает подходящее и приводит типы', () => {
    expect(pipe.transform({ email: 'a@b.com', age: '30' })).toEqual({
      email: 'a@b.com',
      age: 30,
    });
  });

  it('на непройденную проверку отвечает 400 со списком полей', () => {
    try {
      pipe.transform({ email: 'не почта', age: '10' });
      throw new Error('ожидался отказ');
    } catch (error) {
      const response = (error as HttpException).getResponse() as {
        message: string;
        errors: { field: string; message: string }[];
      };

      expect((error as HttpException).getStatus()).toBe(400);
      // Разом про все поля: чинить форму по одному полю за запрос —
      // худшее, что можно предложить человеку
      expect(response.errors.map((issue) => issue.field).sort()).toEqual([
        'age',
        'email',
      ]);
      expect(response.errors[0]!.message).toBeTruthy();
    }
  });
});

describe('Счётчик обращений по аккаунту', () => {
  /** Ограничитель с коротким окном: три обращения за минуту. */
  function limiter(limit = 3): AccountRateLimiter {
    return new AccountRateLimiter(
      limit,
      60,
      (seconds) => `Повторите через ${seconds} секунд`,
    );
  }

  it('пропускает, пока не выбран лимит', () => {
    const limit = limiter();

    expect(() => {
      limit.hit('user-1');
      limit.hit('user-1');
      limit.hit('user-1');
    }).not.toThrow();
  });

  it('на лишнее обращение отвечает 429 и говорит, когда повторить', () => {
    const limit = limiter();

    limit.hit('user-1');
    limit.hit('user-1');
    limit.hit('user-1');

    try {
      limit.hit('user-1');
      throw new Error('ожидался отказ');
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).message).toMatch(/Повторите через \d+/);
    }
  });

  it('считает каждому аккаунту отдельно', () => {
    const limit = limiter(1);

    limit.hit('user-1');

    // Иначе один активный человек закрывал бы вход всем остальным
    expect(() => limit.hit('user-2')).not.toThrow();
  });

  it('после окна счёт начинается заново', () => {
    const limit = new AccountRateLimiter(1, 60, () => 'подождите');

    limit.hit('user-1');
    expect(() => limit.hit('user-1')).toThrow();

    // Перематываем время вперёд за границу окна
    const later = Date.now() + 61_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);

    expect(() => limit.hit('user-1')).not.toThrow();

    now.mockRestore();
  });
});

describe('Ограничитель частоты по адресу клиента', () => {
  /** Обработчик с наклейкой @RateLimit и без неё. */
  class Handlers {
    @RateLimit({ limit: 2, windowSeconds: 60 })
    limited(): void {}

    open(): void {}
  }

  /** Поддельный контекст запроса: охраннику нужны адрес и обработчик. */
  function contextFor(ip: string, handler: () => void): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ ip }) }),
      getHandler: () => handler,
      getClass: () => Handlers,
    } as unknown as ExecutionContext;
  }

  const handlers = new Handlers();
  let guard: RateLimitGuard;

  beforeEach(() => {
    guard = new RateLimitGuard(new Reflector());
  });

  it('без наклейки пропускает всех', () => {
    const context = contextFor('10.0.0.1', handlers.open);

    for (let i = 0; i < 100; i += 1) {
      expect(guard.canActivate(context)).toBe(true);
    }
  });

  it('с наклейкой считает и отказывает после лимита', () => {
    const context = contextFor('10.0.0.1', handlers.limited);

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(HttpException);
  });

  it('разным адресам — разный счёт', () => {
    const first = contextFor('10.0.0.1', handlers.limited);
    const second = contextFor('10.0.0.2', handlers.limited);

    guard.canActivate(first);
    guard.canActivate(first);

    expect(guard.canActivate(second)).toBe(true);
  });

  it('наклейка кладёт на метод то, что читает охранник', () => {
    expect(new Reflector().get(RATE_LIMIT_KEY, handlers.limited)).toEqual({
      limit: 2,
      windowSeconds: 60,
    });
  });
});

describe('Описание запросов из zod-схем', () => {
  const schema = z.object({
    limit: z.coerce.number().int().default(20),
    status: z.enum(['active', 'blocked']).optional(),
    q: z.string(),
  });

  it('переводит схему в описание OpenAPI', () => {
    const converted = zodToOpenApi(schema) as {
      type: string;
      properties: Record<string, unknown>;
    };

    expect(converted.type).toBe('object');
    expect(Object.keys(converted.properties).sort()).toEqual([
      'limit',
      'q',
      'status',
    ]);
  });

  it('описывает вход, а не выход: limit со значением по умолчанию не обязателен', () => {
    const converted = zodToOpenApi(schema) as { required?: string[] };

    // Клиент присылает строку и может её не присылать вовсе — описывать
    // надо именно это, а не то, что получится после разбора
    expect(converted.required).toEqual(['q']);
  });

  it('собирает декораторы параметров строки запроса', () => {
    // Сам факт, что перевод не падает и отдаёт декоратор: содержимое
    // проверяется выше, а сборка — это уже дело Swagger
    expect(typeof ApiZodQuery(schema)).toBe('function');
  });

  it('не спотыкается о проверки, которых в JSON Schema не выразить', () => {
    const refined = z
      .object({ from: z.string(), to: z.string() })
      .refine((value) => value.from <= value.to, 'начало позже конца');

    expect(() => zodToOpenApi(refined)).not.toThrow();
  });
});
