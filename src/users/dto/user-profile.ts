import * as z from 'zod';
import type { User } from '../entities/user.entity.js';

// Проверка номера пользователя из адреса: /users/{userId}
// Мусор вместо номера отсеется до похода в базу, ответом 400.
export const userIdParamSchema = z.object({
  userId: z.uuid('Некорректный идентификатор пользователя'),
});
export type UserIdParam = z.infer<typeof userIdParamSchema>;

/** Все поля, которые вообще бывают в профиле. */
export const PROFILE_FIELDS = [
  'id',
  'email',
  'photo',
  'status',
  'emailVerifiedAt',
  'createdAt',
  'updatedAt',
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** Профиль в ответе. Полей может быть меньше — сколько разрешено. */
export type ProfileView = Partial<Record<ProfileField, unknown>>;

/** Разрешение и действие из ТЗ: право users.read. */
export const PROFILE_PERMISSION = 'users';
export const PROFILE_READ_ACTION = 'read';

/**
 * Политика полей: какое действие разрешения users какие поля открывает.
 *
 * Половина конфигурации здесь, половина в базе, и это намеренно:
 *   — КАКИЕ поля стоят за действием, решает этот файл;
 *   — КОМУ действие выдано, решает RBAC, то есть база.
 *
 * Почему так, а не «список полей строкой в базе»: поле профиля — это
 * свойство кода. Строчкой в базе можно было бы открыть поле, которого нет,
 * или опечататься в названии и молча получить пустоту. Здесь же лишнего
 * поля не появится: набор ProfileField закрыт, а всё, чего нет в политике,
 * не выдаётся никому (default-deny из п. 1.4 ТЗ).
 *
 * Добавили роли действие read_email — она сразу видит почту, перезапуск не
 * нужен: действия приезжают из конфигурации RBAC.
 */
export const PROFILE_FIELD_POLICY: Readonly<
  Record<string, readonly ProfileField[]>
> = {
  // Базовое право на чужой профиль. Ничего личного: кто это и как выглядит
  [PROFILE_READ_ACTION]: ['id', 'photo', 'status', 'createdAt'],
  // Почта — отдельное действие: это личные данные другого человека
  read_email: ['email'],
  // Служебные отметки: когда подтвердил почту, когда менялся профиль
  read_activity: ['emailVerifiedAt', 'updatedAt'],
};

/**
 * Свой профиль: человек видит про себя всё.
 *
 * Отдельно от политики ролей и намеренно не через RBAC: право смотреть себя
 * не выдают и не отбирают, оно есть у всех и всегда.
 */
export const SELF_PROFILE_FIELDS: readonly ProfileField[] = PROFILE_FIELDS;

/** Все поля, которые вообще может открыть набор действий. */
export function fieldsForActions(actions: Iterable<string>): Set<ProfileField> {
  const fields = new Set<ProfileField>();

  for (const action of actions) {
    // Действия, которых нет в политике, не открывают ничего.
    // Это и есть default-deny: неизвестное — значит запрещённое.
    for (const field of PROFILE_FIELD_POLICY[action] ?? []) {
      fields.add(field);
    }
  }

  return fields;
}

/**
 * Собирает ответ из тех полей, которые разрешены. Ключ, которого нет в
 * наборе, в ответ не попадает вовсе — не null и не пустая строка.
 */
export function buildProfileView(
  user: User,
  allowed: ReadonlySet<ProfileField>,
): ProfileView {
  // Полный профиль. Из него ниже останется только разрешённое.
  const full: Record<ProfileField, unknown> = {
    id: user.id,
    email: user.email,
    // В базе колонка называется avatarUrl, в контракте из ТЗ — photo
    photo: user.avatarUrl,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };

  const view: ProfileView = {};

  // Идём по списку разрешённых, а не по всем полям: так новое поле в
  // профиле не утечёт само собой, пока его не впишут в политику.
  for (const field of allowed) {
    view[field] = full[field];
  }

  return view;
}
