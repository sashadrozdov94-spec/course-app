/**
 * Курсор постраничной выборки — это место, на котором остановились:
 * значение поля сортировки плюс номер строки.
 *
 * Номер нужен как «разрешитель ничьей»: у десяти строк может совпасть и
 * значение поля, и секунда создания, а курсорной пагинации нужен полный
 * порядок — без второго ключа страницы то повторяли бы строки, то теряли
 * их. Пара (поле, id) уникальна всегда.
 *
 * Кодируем в base64url, чтобы клиенту не приходило в голову собирать
 * курсор руками: это деталь реализации, а не часть контракта. Поменяется
 * поле сортировки — поменяется и содержимое курсора, и никто не заметит.
 *
 * Лежит в common, а не рядом с конкретным списком: курсор ничего не знает
 * ни о пользователях, ни об истории трансформаций, а нужен обоим. Разные
 * копии одного кодирования разъехались бы при первой же правке.
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
