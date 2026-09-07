import * as z from 'zod';
import type { Permission } from '../entities/permission.entity.js';
import { actionsSchema, identifierSchema } from './identifiers.js';

export const permissionIdParamSchema = z.object({
  permissionId: z.uuid('Некорректный идентификатор разрешения'),
});

export const createPermissionSchema = z.object({
  id: z.uuid().optional(),
  name: identifierSchema,
  // Разрешение без действий бессмысленно: выдавать будет нечего
  actions: actionsSchema.min(1, 'Укажите хотя бы одно действие'),
});
export type CreatePermissionDto = z.infer<typeof createPermissionSchema>;

export const updatePermissionSchema = z
  .object({
    name: identifierSchema.optional(),
    actions: actionsSchema.min(1, 'Укажите хотя бы одно действие').optional(),
  })
  .refine(
    (body) => Object.keys(body).length > 0,
    'Укажите хотя бы одно поле для изменения',
  );
export type UpdatePermissionDto = z.infer<typeof updatePermissionSchema>;

export interface PermissionView {
  id: string;
  name: string;
  actions: string[];
}

export function toPermissionView(permission: Permission): PermissionView {
  return {
    id: permission.id,
    name: permission.name,
    actions: permission.actions,
  };
}
