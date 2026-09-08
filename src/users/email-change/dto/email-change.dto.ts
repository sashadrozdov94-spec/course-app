import * as z from 'zod';

/**
 * Схема запроса на смену почты.
 * Правила те же, что и при регистрации: обрезаем пробелы,
 * приводим к нижнему регистру и проверяем формат.
 */
export const emailChangeSchema = z.strictObject({
  newEmail: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email('Введите настоящий адрес почты'))
    .refine((value) => value.length <= 320, 'Слишком длинный адрес'),
});

export type EmailChangeDto = z.infer<typeof emailChangeSchema>;

/**
 * Схема подтверждения смены почты (вариант A из п. 1.3.3 ТЗ).
 *
 * Вариант B (ссылка) сюда не входит: письмо со ссылкой уходит на новый
 * адрес и открывается в другом браузере, где cookie с access нет. Такой
 * сценарий требует отдельного открытого обработчика, а не этого.
 */
export const confirmEmailChangeSchema = z.strictObject({
  challengeId: z.uuid('Некорректный идентификатор попытки'),
  code: z
    .string()
    .trim()
    .min(4, 'Слишком короткий код')
    .max(10, 'Слишком длинный код'),
});

export type ConfirmEmailChangeDto = z.infer<typeof confirmEmailChangeSchema>;
