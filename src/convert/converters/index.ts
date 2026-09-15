import { CODECS } from '../codecs/index.js';
import type { FormatConverter } from '../format-converter.js';
import { CodecConverter } from './codec-converter.js';

/**
 * Все поддерживаемые направления.
 *
 * Список не пишется руками, а собирается как все пары разных форматов:
 * четыре кодека дают двенадцать направлений — ровно те, что перечислены в
 * п. 1.2 ТЗ. Руками такой список пришлось бы править при каждом новом
 * формате, и легко было бы забыть половину пар.
 *
 * Пара «формат в себя же» (json → json) пропущена намеренно: это не
 * конвертация, а переформатирование, и в ТЗ её нет.
 */
export const CONVERTERS: readonly FormatConverter[] = CODECS.flatMap((reader) =>
  CODECS.filter((writer) => writer.format !== reader.format).map(
    (writer) => new CodecConverter(reader, writer),
  ),
);

/** Найти модуль для направления. undefined — направление не поддерживается. */
export function findConverter(
  source: string,
  target: string,
): FormatConverter | undefined {
  return CONVERTERS.find((c) => c.source === source && c.target === target);
}
