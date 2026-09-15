import { FileFormat } from '../format.js';
import { FormatCodec } from './format-codec.js';

/** Разделитель полей. RFC 4180 знает только запятую. */
const DELIMITER = ',';

/** Кавычка, которой экранируются поля. */
const QUOTE = '"';

/** Конец строки. RFC 4180 требует CRLF. */
const CRLF = '\r\n';

/** Имя колонки для таблицы из простых значений, а не из объектов. */
const SCALAR_COLUMN = 'value';

/**
 * CSV (RFC 4180).
 *
 * Своя реализация, а не библиотека: формат описывается тремя правилами
 * (запятая разделяет, кавычки экранируют, две кавычки внутри кавычек дают
 * одну), и разбор занимает полсотни строк. Зависимость ради этого не
 * окупается, зато поведение на краях — пустые поля, переводы строк внутри
 * кавычек, CRLF против LF — видно прямо здесь.
 *
 * Соглашения для неоднозначных мест (п. 1.4 ТЗ требует их зафиксировать).
 *
 * При чтении (csv → что угодно):
 *
 *   результат       — массив объектов, а не массив массивов: заголовки
 *                     несут смысл, и «массив объектов» — то, чего ждут от
 *                     CSV → JSON в подавляющем большинстве случаев;
 *   первая строка   — всегда заголовок;
 *   типы            — не угадываются: 007 остаётся строкой "007", как и
 *                     при чтении XML. Иначе индексы и телефоны теряли бы
 *                     вид, а «1,5» в одной строке и «нет данных» в другой
 *                     давали бы колонку из разных типов;
 *   пустое поле     — пустая строка;
 *   пустой заголовок — колонка получает имя column1, column2… по номеру:
 *                     выгрузки из таблиц часто заканчиваются лишней
 *                     запятой, и отказывать из-за этого невежливо;
 *   повторы в заголовке — ошибка: одноимённые колонки молча затёрли бы
 *                     друг друга в объекте;
 *   разное число полей в строках — ошибка, этого требует RFC 4180;
 *   CRLF и LF       — читаются оба, как и перевод строки внутри кавычек.
 *
 * При записи (что угодно → csv):
 *
 *   таблица         — ищется массив: если данные и есть массив, он и
 *                     строки; если это объект-обёртка с единственным
 *                     ключом ({"users":[…]} или {"root":{"item":[…]}} из
 *                     XML), обёртка снимается; иначе весь объект — одна
 *                     строка;
 *   вложенность     — разворачивается в колонки с точкой:
 *                     {"a":{"b":1}} → колонка a.b, а элементы массива
 *                     нумеруются: {"a":[1,2]} → колонки a.0 и a.1. Плоская
 *                     таблица не умеет вложенность, а терять данные
 *                     нельзя;
 *   набор колонок   — объединение ключей всех строк в порядке первой
 *                     встречи; чего в строке нет — пустое поле;
 *   строки-скаляры  — колонка value: [1,2] → value/1/2;
 *   null            — пустое поле;
 *   нет ни одной строки — ошибка: из пустого массива не собрать даже
 *                     заголовок, и пустой файл в ответ выглядел бы как
 *                     потеря данных.
 */
export class CsvCodec extends FormatCodec {
  readonly format = FileFormat.Csv;

  parse(input: string): unknown {
    const rows = this.readRows(input);

    if (rows.length === 0) {
      throw new Error('CSV пуст: нет ни одной строки');
    }

    const header = this.readHeader(rows[0]!);
    const records: Record<string, string>[] = [];

    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index]!;

      if (row.length !== header.length) {
        throw new Error(
          `Строка ${index + 1}: полей ${row.length}, а в заголовке ${header.length}. ` +
            'По RFC 4180 во всех строках их должно быть поровну',
        );
      }

      const record: Record<string, string> = {};

      header.forEach((column, position) => {
        record[column] = row[position]!;
      });

      records.push(record);
    }

    return records;
  }

  serialize(value: unknown): string {
    const rows = this.toRows(value).map((row) => this.flatten(row));

    if (rows.length === 0) {
      throw new Error(
        'Нет ни одной строки: из этих данных не получится таблица CSV',
      );
    }

    // Порядок колонок — порядок первой встречи ключа. Map помнит порядок
    // вставки, поэтому отдельного списка не нужно.
    const columns = new Map<string, true>();

    for (const row of rows) {
      for (const key of Object.keys(row)) {
        columns.set(key, true);
      }
    }

    const header = [...columns.keys()];
    const lines = [header.map((column) => this.escape(column)).join(DELIMITER)];

    for (const row of rows) {
      lines.push(
        header.map((column) => this.escape(row[column])).join(DELIMITER),
      );
    }

    return `${lines.join(CRLF)}${CRLF}`;
  }

  /**
   * Разбор текста в строки и поля.
   *
   * Посимвольный автомат, а не split(',') и split('\n'): и запятая, и
   * перевод строки внутри кавычек — обычные символы значения, а разбиение
   * по ним порвало бы поле «Иванов, Иван» на два.
   */
  private readRows(input: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    // Было ли в строке хоть что-то. Нужно, чтобы отличить последнюю
    // строку файла с переводом строки на конце (это не пустая запись) от
    // настоящей пустой строки посередине.
    let started = false;

    const endField = (): void => {
      row.push(field);
      field = '';
      started = true;
    };

    const endRow = (): void => {
      endField();
      rows.push(row);
      row = [];
      started = false;
    };

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index]!;

      if (quoted) {
        if (char !== QUOTE) {
          field += char;
          continue;
        }

        // Две кавычки подряд внутри поля — это одна кавычка в значении
        if (input[index + 1] === QUOTE) {
          field += QUOTE;
          index += 1;
          continue;
        }

        quoted = false;
        continue;
      }

      if (char === QUOTE) {
        if (field.length > 0) {
          throw new Error(
            `Кавычка посреди незакавыченного поля (символ ${index + 1}). ` +
              'По RFC 4180 кавычки либо обрамляют поле целиком, либо удваиваются внутри',
          );
        }

        quoted = true;
        started = true;
        continue;
      }

      if (char === DELIMITER) {
        endField();
        continue;
      }

      if (char === '\r' || char === '\n') {
        // \r\n — один конец строки, а не два
        if (char === '\r' && input[index + 1] === '\n') {
          index += 1;
        }

        if (started || row.length > 0 || field.length > 0) {
          endRow();
        }

        continue;
      }

      field += char;
      started = true;
    }

    if (quoted) {
      throw new Error('Незакрытая кавычка: поле открыто, но не закрыто');
    }

    if (started || row.length > 0 || field.length > 0) {
      endRow();
    }

    return rows;
  }

  /** Заголовки: пустые получают имя по номеру, повторы запрещены. */
  private readHeader(row: string[]): string[] {
    const header = row.map((name, index) =>
      name.trim().length > 0 ? name : `column${index + 1}`,
    );
    const seen = new Set<string>();

    for (const column of header) {
      if (seen.has(column)) {
        throw new Error(
          `Колонка "${column}" встречается в заголовке дважды. ` +
            'Имена колонок должны быть разными',
        );
      }

      seen.add(column);
    }

    return header;
  }

  /**
   * Найти в данных строки таблицы.
   *
   * Обёртки снимаются по одной, пока под ними массив или объект: XML даёт
   * {"root":{"item":[…]}}, а рукописный JSON — {"users":[…]}, и в обоих
   * случаях таблица лежит внутри. Обёртку над простым значением не трогаем:
   * у {"total":42} единственный ключ — это имя колонки, а не обёртка.
   */
  private toRows(value: unknown): unknown[] {
    let current = value;

    while (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      const keys = Object.keys(current);
      const only = keys[0];

      if (keys.length !== 1 || only === undefined) {
        break;
      }

      const inner = (current as Record<string, unknown>)[only];

      if (inner === null || typeof inner !== 'object') {
        break;
      }

      current = inner;
    }

    if (Array.isArray(current)) {
      return current;
    }

    if (current === undefined) {
      return [];
    }

    // Один объект (или одно значение) — таблица из одной строки
    return [current];
  }

  /**
   * Вложенная структура строки → плоский набор колонок.
   *
   * Рекурсия здесь безопасна: глубину уже проверил assertDepth, дальше
   * 64 уровней мы не пойдём.
   */
  private flatten(row: unknown, prefix = ''): Record<string, unknown> {
    if (row === null || typeof row !== 'object') {
      return { [prefix || SCALAR_COLUMN]: row };
    }

    const entries = Array.isArray(row)
      ? row.map((item, index) => [String(index), item] as const)
      : Object.entries(row);

    if (entries.length === 0) {
      // Пустой объект или массив — колонка есть, значения нет. Иначе
      // строка исчезла бы из таблицы целиком.
      return prefix ? { [prefix]: '' } : {};
    }

    const flat: Record<string, unknown> = {};

    for (const [key, nested] of entries) {
      const path = prefix ? `${prefix}.${key}` : key;

      Object.assign(flat, this.flatten(nested, path));
    }

    return flat;
  }

  /** Одно поле в текст: кавычки там, где без них разобрать нельзя. */
  private escape(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }

    const text = typeof value === 'string' ? value : String(value);

    const needsQuotes =
      text.includes(DELIMITER) ||
      text.includes(QUOTE) ||
      text.includes('\n') ||
      text.includes('\r') ||
      text !== text.trim();

    return needsQuotes
      ? `${QUOTE}${text.replaceAll(QUOTE, QUOTE + QUOTE)}${QUOTE}`
      : text;
  }
}
