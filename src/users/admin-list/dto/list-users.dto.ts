import * as z from 'zod';
import { UserStatus } from '../../entities/user.entity.js';

/** Границы страницы из ТЗ: 20–100, по умолчанию 20. */
export const PAGE_SIZE_MIN = 1;
export const PAGE_SIZE_MAX = 100;
export const PAGE_SIZE_DEFAULT = 20;

/**
 * По чему разрешено сортировать.
 *
 * Список закрытый и сопоставлен с колонками здесь, а не собирается из
 * строки запроса: иначе клиент задавал бы произвольное выражение в ORDER BY.
 * Плюс п. 1.4 ТЗ прямо требует ограничить поля, чтобы не ловить тяжёлые
 * запросы — у всех трёх колонок есть индекс.
 */
export const SORT_COLUMNS = {
  created_at: 'createdAt',
  last_login: 'lastLoginAt',
  email: 'email',
} as const;

export type SortKey = keyof typeof SORT_COLUMNS;

export const listUsersSchema = z.strictObject({
  // Курсор непрозрачен для клиента: он его только возвращает как получил
  cursor: z.string().max(512).optional(),

  // z.coerce, потому что из строки запроса всё приходит строками
  limit: z.coerce
    .number()
    .int()
    .min(PAGE_SIZE_MIN, `Минимум ${PAGE_SIZE_MIN}`)
    .max(PAGE_SIZE_MAX, `Максимум ${PAGE_SIZE_MAX}`)
    .default(PAGE_SIZE_DEFAULT),

  // Поиск: точный номер или начало адреса почты. Подробности — в сервисе
  q: z.string().trim().min(1).max(320).optional(),

  // Значения статуса берём из самого перечисления: «deleted» в ТЗ есть, а
  // у нас нет — удаление физическое, строки просто не остаётся
  status: z.enum(UserStatus).optional(),

  sort: z.enum(['created_at', 'last_login', 'email']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type ListUsersDto = z.infer<typeof listUsersSchema>;

/** Одна строка списка. Чувствительных полей здесь нет и быть не может. */
export interface UserListItem {
  id: string;
  /** Полностью — только с правом users@read_email, иначе замаскирован */
  email: string;
  photo: string | null;
  status: UserStatus;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface UserListPage {
  items: UserListItem[];
  nextCursor: string | null;
}

/**
 * Курсор — это место, на котором остановились: значение поля сортировки
 * плюс номер строки.
 *
 * Номер нужен как «разрешитель ничьей»: у десяти пользователей может быть
 * одинаковый статус и одна и та же секунда создания, и без второго ключа
 * страницы то повторяли бы строки, то теряли их. Пара (поле, id)
 * уникальна всегда, поэтому пагинация устойчива (п. 1.6 ТЗ).
 *
 * Кодируем в base64url, чтобы клиенту не приходило в голову собирать
 * курсор руками: это деталь реализации, а не часть контракта.
 */
export interface Cursor {
  /** Значение поля сортировки у последней отданной строки */
  value: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Разбирает курсор. Мусор — не ошибка сервера, а 400 у вызывающего. */
export function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Cursor).value !== 'string' ||
      typeof (parsed as Cursor).id !== 'string'
    ) {
      return null;
    }

    return parsed as Cursor;
  } catch {
    return null;
  }
}

/**
 * Маскировка адреса: `ivan@example.com` → `iv***@example.com`.
 *
 * Отвечает на вопрос ТЗ «или маскировать часть — требует решения».
 * Показываем ровно столько, чтобы администратор узнал знакомый адрес и
 * отличил один от другого, но не мог выгрузить список рабочих адресов.
 * Полный адрес открывает отдельное право users@read_email — то же самое,
 * что и при просмотре одного профиля.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');

  if (at <= 0) {
    return '***';
  }

  const name = email.slice(0, at);
  const domain = email.slice(at);
  const visible = name.slice(0, Math.min(2, name.length));

  return `${visible}***${domain}`;
}
