import * as z from 'zod';

/**
 * Номер пользователя из адреса: /users/{userId}.
 *
 * Лежит отдельно, потому что нужен всем трём сценариям — профилю, смене
 * почты и удалению. Мусор вместо номера отсеется до похода в базу, ответом 400.
 */
export const userIdParamSchema = z.object({
  userId: z.uuid('Некорректный идентификатор пользователя'),
});
export type UserIdParam = z.infer<typeof userIdParamSchema>;
