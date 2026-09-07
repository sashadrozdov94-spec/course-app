import * as z from 'zod';
import type { Role } from '../entities/role.entity.js';
import { identifierSchema } from './identifiers.js';

export const roleIdParamSchema = z.object({
  roleId: z.uuid('Некорректный идентификатор роли'),
});

export const createRoleSchema = z.object({
  // Номер можно задать самому — ТЗ разрешает передавать id.
  // Не передали — база сгенерирует его сама.
  id: z.uuid().optional(),
  name: identifierSchema,
  description: z.string().max(255).optional(),
});
export type CreateRoleDto = z.infer<typeof createRoleSchema>;

// PUT меняет только присланные поля. Пустое тело запрещаем:
// это почти всегда ошибка клиента, а не осмысленный запрос.
export const updateRoleSchema = z
  .object({
    name: identifierSchema.optional(),
    description: z.string().max(255).nullable().optional(),
  })
  .refine(
    (body) => Object.keys(body).length > 0,
    'Укажите хотя бы одно поле для изменения',
  );
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;

// Наружу отдаём ровно те поля, что описаны в ТЗ
export interface RoleView {
  id: string;
  name: string;
  description: string | null;
}

export function toRoleView(role: Role): RoleView {
  return { id: role.id, name: role.name, description: role.description };
}
