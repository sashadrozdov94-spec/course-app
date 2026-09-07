import * as z from 'zod';

/**
 * Как выглядит название роли, разрешения или действия.
 *
 * Строчные латинские буквы, цифры, _ и -. Начинается с буквы.
 * Символа @ здесь быть не может специально: он разделяет две части
 * в записи «ресурс@действие», и внутри названий сломал бы разбор.
 */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]*$/;

const IDENTIFIER_MESSAGE =
  'Только строчные латинские буквы, цифры, _ и -, начиная с буквы';

export const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(IDENTIFIER_PATTERN, IDENTIFIER_MESSAGE);

/** Список действий: без пустых значений и без повторов. */
export const actionsSchema = z
  .array(identifierSchema)
  .max(64, 'Слишком много действий')
  .refine(
    (actions) => new Set(actions).size === actions.length,
    'Действия не должны повторяться',
  );

/**
 * DELETE ...?force=true — удалить вместе с назначениями.
 *
 * Без флага сущность с назначениями удалить нельзя: ответ 409. Флаг —
 * это ответ на вопрос ТЗ «запрещать или удалять каскадно»: решает тот,
 * кто удаляет, а молчаливого каскада не бывает.
 */
export const forceQuerySchema = z.object({
  force: z.stringbool().default(false),
});
export type ForceQuery = z.infer<typeof forceQuerySchema>;
