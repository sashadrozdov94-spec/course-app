import type { FormatCodec } from '../codecs/format-codec.js';
import type { FileFormat } from '../format.js';
import { FormatConverter } from '../format-converter.js';
import { assertStructure } from './structure-limits.js';

/**
 * Направление, собранное из двух кодеков: читатель и писатель.
 *
 * Вся конвертация — три шага: прочитать исходный формат во внутреннее
 * представление, проверить это представление на вменяемость, записать в
 * целевой формат. Шаги одинаковы для всех двенадцати направлений, поэтому
 * класс ровно один.
 *
 * Проверка глубины и размера стоит посередине не случайно: после разбора
 * уже видно настоящую структуру (лимит на размер файла её не ограничивает:
 * полтора килобайта скобок дают тысячу уровней вложенности), а до записи
 * ещё не потрачена память на сборку результата.
 */
export class CodecConverter extends FormatConverter {
  readonly source: FileFormat;
  readonly target: FileFormat;

  constructor(
    private readonly reader: FormatCodec,
    private readonly writer: FormatCodec,
  ) {
    super();
    this.source = reader.format;
    this.target = writer.format;
  }

  convert(input: string): string {
    const data = this.reader.parse(input);

    assertStructure(data);

    return this.writer.serialize(data);
  }
}
