import * as z from 'zod';
import type { Grant } from '../entities/grant.entity.js';
import { actionsSchema } from './identifiers.js';

export const grantIdParamSchema = z.object({
  grantId: z.uuid('Некорректный идентификатор назначения'),
});

export const createGrantSchema = z.object({
  id: z.uuid().optional(),
  roleId: z.uuid('Некорректный идентификатор роли'),
  permissionId: z.uuid('Некорректный идентификатор разрешения'),
  // Не прислали или прислали пустой список — по ТЗ это «все действия»
  actions: actionsSchema.optional(),
});
export type CreateGrantDto = z.infer<typeof createGrantSchema>;

export const updateGrantSchema = z
  .object({
    roleId: z.uuid('Некорректный идентификатор роли').optional(),
    permissionId: z.uuid('Некорректный идентификатор разрешения').optional(),
    actions: actionsSchema.optional(),
  })
  .refine(
    (body) => Object.keys(body).length > 0,
    'Укажите хотя бы одно поле для изменения',
  );
export type UpdateGrantDto = z.infer<typeof updateGrantSchema>;

export interface GrantView {
  id: string;
  roleId: string;
  permissionId: string;
  actions: string[];
  /**
   * Подсказка клиенту: пустой список действий читается не как «ничего
   * нельзя», а как «можно всё». Флаг убирает эту двусмысленность из ответа.
   */
  allActions: boolean;
}

export function toGrantView(grant: Grant): GrantView {
  return {
    id: grant.id,
    roleId: grant.roleId,
    permissionId: grant.permissionId,
    actions: grant.actions,
    allActions: grant.actions.length === 0,
  };
}
