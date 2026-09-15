import { FileFormat } from '../format.js';
import { FormatCodec } from './format-codec.js';

/**
 * JSON (RFC 8259).
 *
 * Самый простой кодек: внутреннее представление и есть модель данных
 * JSON, поэтому ни преобразований, ни соглашений здесь нет.
 *
 * Пишем с отступом в два пробела, а не одной строкой: результат чаще
 * всего открывают глазами, а не скармливают машине — за это стоит
 * заплатить лишними байтами.
 */
export class JsonCodec extends FormatCodec {
  readonly format = FileFormat.Json;

  parse(input: string): unknown {
    try {
      return JSON.parse(input);
    } catch (error) {
      throw new Error(
        `Некорректный JSON: ${(error as Error).message.slice(0, 200)}`,
      );
    }
  }

  serialize(value: unknown): string {
    // undefined в JSON не записывается: JSON.stringify вернул бы для него
    // undefined вместо строки, и клиент получил бы пустое тело.
    if (value === undefined) {
      throw new Error('Нечего записывать: данные пусты');
    }

    return `${JSON.stringify(value, null, 2)}\n`;
  }
}
