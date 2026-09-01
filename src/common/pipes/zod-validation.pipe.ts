import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

// Охранник на входе в контроллер.
// Берёт то, что прислал клиент, и проверяет по схеме zod.
// Не подошло — ошибка 400, дальше запрос не идёт.
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // Собираем понятный список: какое поле и что с ним не так
      throw new BadRequestException({
        message: 'Проверьте введённые данные',
        errors: result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    // Вернули уже проверенные и причёсанные данные
    return result.data;
  }
}
