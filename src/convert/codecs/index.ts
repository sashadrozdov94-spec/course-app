import { CsvCodec } from './csv.codec.js';
import type { FormatCodec } from './format-codec.js';
import { JsonCodec } from './json.codec.js';
import { XmlCodec } from './xml.codec.js';
import { YamlCodec } from './yaml.codec.js';

/**
 * Все известные приложению форматы.
 *
 * Единственное место, которое правится при добавлении формата: одна
 * строка здесь, новый класс кодека и новое значение в FileFormat.
 * Контроллер, сервис, схемы запросов и остальные кодеки остаются как есть —
 * ровно этого требует ТЗ от расширяемости. Все направления с новым
 * форматом появятся сами, в обе стороны.
 *
 * Обычный массив, а не провайдеры Nest: этот же список нужен рабочему
 * потоку, где контейнера нет. Импорт работает в обоих местах одинаково.
 */
export const CODECS: readonly FormatCodec[] = [
  new CsvCodec(),
  new JsonCodec(),
  new XmlCodec(),
  new YamlCodec(),
];
