import * as z from 'zod';

/**
 * Тело запроса на удаление. Целиком необязательное: причина нужна
 * поддержке, а не логике, и её отсутствие не повод отказывать.
 */
export const deleteUserSchema = z.strictObject({
  reason: z.string().trim().max(255).optional(),
});
export type DeleteUserDto = z.infer<typeof deleteUserSchema>;

/** Подтверждение удаления кодом (вариант A). */
export const confirmDeletionSchema = z.strictObject({
  challengeId: z.uuid('Некорректный идентификатор попытки'),
  code: z
    .string()
    .trim()
    .min(4, 'Слишком короткий код')
    .max(10, 'Слишком длинный код'),
});
export type ConfirmDeletionDto = z.infer<typeof confirmDeletionSchema>;
