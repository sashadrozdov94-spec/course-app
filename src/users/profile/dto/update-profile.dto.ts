import * as z from 'zod';
import { type User, UserStatus } from '../../entities/user.entity.js';

/**
 * Что вообще можно менять в профиле.
 *
 * Схема строгая (strictObject): ключ, которого здесь нет, — это 400, а не
 * молчаливое «поле проигнорировано». Клиент должен узнать, что его правку
 * не приняли.
 *
 * email в схеме ЕСТЬ, хотя обычному человеку менять его через этот адрес
 * нельзя. Так сделано намеренно: по ТЗ ответ на такую попытку — 403 «только
 * через подтверждение», а не 400 «нет такого поля». Значит, поле должно
 * пройти разбор и упереться в проверку прав, а не в схему.
 */
export const updateProfileSchema = z
  .strictObject({
    // Ссылка на фото или путь к файлу. Проверяем только длину: файловое
    // хранилище появится позже и может отдавать не полный URL.
    photo: z.string().trim().min(1).max(512).nullable().optional(),

    status: z.enum(UserStatus).optional(),

    email: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email('Введите настоящий адрес почты'))
      .refine((value) => value.length <= 320, 'Слишком длинный адрес')
      .optional(),
  })
  // Пустое тело — почти всегда ошибка клиента, а не осмысленный запрос
  .refine(
    (patch) => Object.keys(patch).length > 0,
    'Укажите хотя бы одно поле для изменения',
  );

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;

/** Поле профиля, которое вообще бывает в patch. */
export type UpdatableField = keyof UpdateProfileDto;

/**
 * Кому какие поля разрешено менять (default-deny из п. 1.6 ТЗ).
 *
 * Устроено так же, как политика на чтение в user-profile.ts: набор полей —
 * в коде, а КОМУ выдано действие users@update — в базе, в конфигурации RBAC.
 *
 * Себе человек меняет только фото. Почта — отдельным сценарием с
 * подтверждением, состояние аккаунта — дело администратора: иначе
 * заблокированный разблокировал бы себя сам.
 */
export const PROFILE_UPDATE_POLICY = {
  /** Свой профиль. Не выдаётся и не отбирается — есть у всех и всегда. */
  self: ['photo'],
  /** Чужой профиль, действие users@update. */
  update: ['photo', 'status', 'email'],
} as const satisfies Record<string, readonly UpdatableField[]>;

/** Колонки таблицы users, которые этот эндпоинт умеет менять. */
export type ProfileColumnPatch = Partial<
  Pick<User, 'avatarUrl' | 'status' | 'email'>
>;

/**
 * Переводит patch из контракта в набор колонок для UPDATE.
 *
 * Заодно работает белым списком: в UPDATE попадёт только то, что здесь
 * разобрано по именам. Случайное поле из тела запроса до базы не доедет,
 * даже если проскочит мимо схемы.
 */
export function toColumnPatch(patch: UpdateProfileDto): ProfileColumnPatch {
  const columns: ProfileColumnPatch = {};

  for (const [field, value] of Object.entries(patch)) {
    switch (field as UpdatableField) {
      // Единственное расхождение имён: в ТЗ поле photo, в базе avatarUrl
      case 'photo':
        columns.avatarUrl = value as string | null;
        break;
      case 'status':
        columns.status = value as UserStatus;
        break;
      case 'email':
        columns.email = value as string;
        break;
    }
  }

  return columns;
}
