/**
 * Коды ошибок Postgres, которые приложение переводит в понятные ответы.
 *
 * Ловить ошибку базы, а не проверять занятость отдельным запросом, —
 * сознательный выбор: между проверкой и записью значение может занять
 * кто-то ещё. Настоящую уникальность держит индекс, а наша задача —
 * превратить его отказ в осмысленный 409.
 */
const UNIQUE_VIOLATION = '23505';

/**
 * Нарушено уникальное ограничение: такое значение уже есть.
 *
 * Смотрим в два места: repository.save() отдаёт ошибку драйвера как есть,
 * а некоторые пути TypeORM заворачивают её в QueryFailedError и кладут
 * оригинал в driverError. Одна проверка на оба случая.
 */
export function isUniqueViolation(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    driverError?: { code?: string };
  } | null;

  return (
    candidate?.code === UNIQUE_VIOLATION ||
    candidate?.driverError?.code === UNIQUE_VIOLATION
  );
}
