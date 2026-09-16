import * as z from 'zod';

/**
 * Номер записи истории из адреса: /history/{itemId}/download.
 *
 * Мусор вместо номера отсеется до похода в базу, ответом 400. Это не
 * только про аккуратность: без проверки в запрос ушла бы произвольная
 * строка, а Postgres на несуществующем типе uuid отвечает ошибкой, из
 * которой получился бы 500 вместо честного «некорректный номер».
 */
export const itemIdParamSchema = z.object({
  itemId: z.uuid('Некорректный идентификатор записи истории'),
});

export type ItemIdParam = z.infer<typeof itemIdParamSchema>;
