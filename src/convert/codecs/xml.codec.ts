import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { FileFormat } from '../format.js';
import { FormatCodec } from './format-codec.js';

/** Имя корня, когда своего имени у данных нет. */
const DEFAULT_ROOT = 'root';

/** Имя элемента для элементов массива: у них имени взяться неоткуда. */
const ARRAY_ITEM = 'item';

/** Префикс, которым помечаются атрибуты. Одинаков при чтении и записи. */
const ATTRIBUTE_PREFIX = '@';

/** Ключ для текста элемента. Тоже одинаков в обе стороны. */
const TEXT_KEY = '#text';

/**
 * Допустимое имя XML-элемента.
 *
 * Проверяем сами, а не доверяем сборщику: имя приходит из ключа объекта —
 * из JSON, из заголовка колонки CSV, из ключа YAML, — а там может
 * оказаться пробел, цифра в начале или «<». Сборщик подставил бы это в
 * разметку как есть и выдал сломанный XML, то есть мы бы отдали мусор
 * вместо честной ошибки.
 */
const XML_NAME = /^[A-Za-z_][\w.-]*$/;

/**
 * XML 1.0.
 *
 * Соглашения для неоднозначных мест — п. 1.4 ТЗ требует их зафиксировать.
 *
 * При чтении (xml → что угодно):
 *
 *   атрибуты            — ключи с префиксом @: <a id="1"/> → {"a":{"@id":"1"}};
 *   повторяющиеся теги  — массив: <a><b/><b/></a> → {"a":{"b":["",""]}};
 *   одиночный тег       — НЕ массив, даже если в схеме он повторяемый:
 *                         из одного экземпляра этого не видно;
 *   текст рядом с атрибутами — ключ #text;
 *   пустой элемент      — пустая строка;
 *   типы                — не угадываются: "1" остаётся строкой "1", а не
 *                         числом. Иначе телефон +7... или почтовый индекс
 *                         007 превращались бы в числа и теряли вид;
 *   <?xml ...?>         — отбрасывается: это метаданные о версии и
 *                         кодировке, а не содержимое.
 *
 * При записи (что угодно → xml):
 *
 *   корень          — если на верхнем уровне ровно один ключ и он годится
 *                     в имя элемента, он и становится корнем:
 *                     {"note":{...}} → <note>...</note>. Иначе корень
 *                     называется <root>: в JSON, YAML и CSV корня нет, а в
 *                     XML он обязателен. Благодаря первому правилу проход
 *                     xml → json → xml возвращает исходную разметку;
 *   массивы         — повторяющиеся элементы с именем ключа:
 *                     {"a":[1,2]} → <a>1</a><a>2</a>;
 *   массив в корне  — элементы получают имя <item>: два корневых элемента
 *                     дали бы невалидный документ;
 *   ключи с @       — атрибуты: {"@id":"1"} → <root id="1">;
 *   ключ #text      — текст элемента;
 *   null            — пустой элемент <a/>;
 *   числа и true/false — записываются как есть: типов в XML нет.
 *
 * Безопасность (п. 1.6 ТЗ: «запрет внешних сущностей в XML»): парсер
 * работает с processEntities: false, то есть не раскрывает ни собственные,
 * ни внешние сущности. Это закрывает и XXE — чтение файлов сервера через
 * <!ENTITY xxe SYSTEM "file:///etc/passwd">, — и «billion laughs», когда
 * несколько килобайт объявлений раздуваются в гигабайты текста.
 */
export class XmlCodec extends FormatCodec {
  readonly format = FileFormat.Xml;

  private readonly parser = new XMLParser({
    attributeNamePrefix: ATTRIBUTE_PREFIX,
    ignoreAttributes: false,
    textNodeName: TEXT_KEY,
    // Ключевая настройка: сущности не раскрываются. См. комментарий выше.
    processEntities: false,
    // Объявление <?xml?> и прочие инструкции обработки — не данные
    ignoreDeclaration: true,
    ignorePiTags: true,
    // Значения не приводим к числам и логическим: "007" должно остаться "007"
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
  });

  private readonly builder = new XMLBuilder({
    attributeNamePrefix: ATTRIBUTE_PREFIX,
    ignoreAttributes: false,
    textNodeName: TEXT_KEY,
    format: true,
    indentBy: '  ',
    // Экранирование включено: значение вида «a < b» не должно ломать разметку
    processEntities: true,
    suppressEmptyNode: true,
  });

  parse(input: string): unknown {
    // Сначала проверка синтаксиса: сам разбор на битом документе может
    // молча вернуть половину структуры вместо ошибки.
    const validation = XMLValidator.validate(input, {
      allowBooleanAttributes: true,
    });

    if (validation !== true) {
      const { line, col, msg } = validation.err;
      throw new Error(
        `Некорректный XML (строка ${line}, столбец ${col}): ${msg}`,
      );
    }

    // Объявление DOCTYPE отклоняем целиком. Сущности мы и так не
    // раскрываем, но документ с DTD в этой задаче не нужен, а его разбор —
    // лишняя поверхность для атаки.
    if (/<!DOCTYPE/i.test(input)) {
      throw new Error(
        'XML с объявлением DOCTYPE не принимается: внешние сущности запрещены',
      );
    }

    return this.parser.parse(input);
  }

  serialize(value: unknown): string {
    if (value === undefined) {
      throw new Error('Нечего записывать: данные пусты');
    }

    // Проверяем все ключи заранее, до сборки. Отдать 400 с указанием
    // плохого ключа полезнее, чем собрать невалидный XML: во втором случае
    // человек узнает о проблеме, только когда его файл где-то не откроется.
    this.assertNames(value);

    const { name, body } = this.resolveRoot(value);

    // Массив прямо под корнем дал бы несколько корневых элементов —
    // документ был бы невалиден. Даём элементам имя <item>.
    const content = Array.isArray(body) ? { [ARRAY_ITEM]: body } : body;

    const xml = this.builder.build({ [name]: content }) as string;

    return `<?xml version="1.0" encoding="UTF-8"?>\n${xml.trimEnd()}\n`;
  }

  /**
   * Как назвать корневой элемент.
   *
   * Единственный ключ верхнего уровня забираем себе: так документ,
   * прочитанный из XML, при записи получает обратно своё имя корня, и
   * проход xml → json → xml не переименовывает его в <root>. Ключ,
   * который не годится в имя элемента (атрибут, #text, пробел внутри),
   * себе не берём — для него нужен настоящий <root>.
   */
  private resolveRoot(value: unknown): { name: string; body: unknown } {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      const only = keys[0];

      if (keys.length === 1 && only !== undefined && XML_NAME.test(only)) {
        return { name: only, body: (value as Record<string, unknown>)[only] };
      }
    }

    return { name: DEFAULT_ROOT, body: value };
  }

  private assertNames(value: unknown, path = ''): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.assertNames(item, path);
      }
      return;
    }

    if (value === null || typeof value !== 'object') {
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      const name = key.startsWith(ATTRIBUTE_PREFIX) ? key.slice(1) : key;
      const here = path ? `${path}.${key}` : key;

      if (key !== TEXT_KEY && !XML_NAME.test(name)) {
        throw new Error(
          `Ключ "${here}" нельзя записать как элемент XML. ` +
            'Имя должно начинаться с буквы или _ и содержать только буквы, цифры, _, - и точку',
        );
      }

      this.assertNames(nested, here);
    }
  }
}
