import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ConversionError } from '../conversion-error.js';

/**
 * Что мы узнали о документе SVG: его собственные размеры.
 *
 * null означает «своего размера по этой оси у документа нет» — так бывает
 * у картинок с одним viewBox или с размером в процентах. Что делать в этом
 * случае, решает вызывающий код: ТЗ разрешает подставить значение из
 * настроек.
 */
export interface SvgDocument {
  width: number | null;
  height: number | null;
}

/**
 * Элементы, которых в принимаемом SVG быть не должно.
 *
 * Имена сравниваются в нижнем регистре и без префикса пространства имён:
 * <SCRIPT>, <svg:script> и <script> — одно и то же.
 *
 *   script                    — исполняемый код;
 *   handler                   — то же в SVG Tiny;
 *   foreignObject             — врезка произвольного HTML, а внутри снова
 *                               скрипты, формы и всё остальное;
 *   iframe, embed, object     — загрузка стороннего документа;
 *   audio, video              — загрузка стороннего файла.
 *
 * Список запрещённых, а не разрешённых: элементов рисования в SVG много,
 * они безобидны, и белый список пришлось бы вести десятками имён, попутно
 * ломая законные картинки при каждой новой версии стандарта. Опасное же
 * наперечёт — это всё, что исполняет код или ходит наружу.
 */
const FORBIDDEN_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'handler',
  'foreignobject',
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
]);

/**
 * Атрибуты-ссылки. Их значение проверяется отдельно: сам по себе href
 * законен — им пользуются <use> и <image>, — а вот куда он ведёт, важно.
 */
const LINK_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src']);

/**
 * Куда ссылке вести можно.
 *
 *   #id          — внутрь этого же документа;
 *   data:image/  — картинка, вложенная прямо в разметку.
 *
 * Всё прочее — обращение наружу: http и https тянут файл с чужого сервера
 * (заодно сообщая ему адрес нашего), file читает диск сервера, javascript
 * исполняет код. ТЗ требует запретить внешние ресурсы, и запрет здесь
 * сплошной: относительный путь вроде ../secret.png — тоже обращение к
 * файловой системе.
 *
 * Прочие data: (например data:text/html) не разрешаем: в <image> они
 * бессмысленны, а в <a> дают страницу с произвольным содержимым.
 */
const SAFE_LINK = /^(?:#|data:image\/)/i;

/** Атрибут-обработчик события: onload, onclick, onmouseover и десятки других. */
const EVENT_ATTRIBUTE = /^on./i;

/**
 * Опасное в стилях: внешние ресурсы и код.
 *
 * url(#...) оставляем — так в SVG ссылаются на собственные градиенты и
 * маски, без этого не работает половина настоящих картинок.
 */
const UNSAFE_STYLE = /@import|javascript:|url\(\s*['"]?(?!#|data:image\/)/i;

/** Единицы длины CSS в пикселях. Процентов и em здесь нет: см. toPixels. */
const UNITS_IN_PIXELS: Readonly<Record<string, number>> = {
  '': 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};

/** Число с необязательной единицей: 100, 12.5px, 3in. */
const LENGTH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)\s*$/i;

/** Узел в режиме preserveOrder: ключ-имя с детьми и отдельный ключ атрибутов. */
type XmlNode = Record<string, unknown> & { ':@'?: Record<string, string> };

/** Ключ, под которым preserveOrder держит атрибуты узла. */
const ATTRIBUTES_KEY = ':@';

/** Ключ текстового узла. */
const TEXT_KEY = '#text';

const PARSER = new XMLParser({
  // preserveOrder даёт узлы как они есть: имя, атрибуты, дети. Обычный
  // режим сворачивает повторяющиеся теги и теряет часть структуры, а нам
  // нужно обойти ровно то, что написано в файле
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // Сущности не раскрываются. См. комментарий к inspectSvg
  processEntities: false,
  // Атрибут без значения (<foo disabled/>) — не повод уронить разбор:
  // решать судьбу такого файла должны проверки ниже, а не парсер
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

/**
 * Разбор SVG: проверка безопасности и собственные размеры за один проход.
 *
 * Почему это одно действие, а не два. Разобрать документ дважды — значит
 * дважды заплатить за самую дорогую часть работы, а главное — оставить
 * щель между проверкой и чтением: проверили один текст, размеры взяли из
 * другого разбора. Здесь дерево одно.
 *
 * Почему проверяем сами, а не полагаемся на библиотеку растеризации.
 * Растеризатор решает свою задачу — нарисовать, — и его представления о
 * допустимом меняются от версии к версии. Полагаться на то, что он
 * промолчит про <script>, нельзя: молчание может означать и «не
 * поддерживаю», и «выполнил». ТЗ требует отклонить такой файл, а не
 * нарисовать его без скрипта.
 *
 * Сущности не раскрываются (processEntities: false), а документ с DOCTYPE
 * отклоняется целиком — это закрывает XXE, то есть чтение файлов сервера
 * через <!ENTITY xxe SYSTEM "file:///etc/passwd">, и «billion laughs»,
 * когда несколько килобайт объявлений раздуваются в гигабайты текста.
 *
 * Отказы бросаются ConversionError: сервис переведёт их в 400.
 */
export function inspectSvg(text: string): SvgDocument {
  assertNoDoctype(text);

  const problem = XMLValidator.validate(text, { allowBooleanAttributes: true });

  if (problem !== true) {
    throw new ConversionError(
      `SVG не является корректной разметкой XML: ${problem.err.msg} ` +
        `(строка ${problem.err.line})`,
    );
  }

  const root = walk(PARSER.parse(text) as XmlNode[]);

  if (!root) {
    throw new ConversionError('В файле нет корневого элемента <svg>');
  }

  return readSize(root);
}

/**
 * Объявление типа документа.
 *
 * Ищем в исходном тексте, а не в дереве: разборщик объявление проглатывает
 * молча, и по дереву не видно, было оно или нет. Проверка грубая — совпадёт
 * и на «<!DOCTYPE» внутри комментария, — но ошибка здесь безопасная: у
 * настоящих картинок этой строки не бывает, а цена пропуска несравнима.
 */
function assertNoDoctype(text: string): void {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) {
    throw new ConversionError(
      'SVG с объявлением DOCTYPE или собственными сущностями не принимается: ' +
        'через них читают файлы сервера',
    );
  }
}

/**
 * Обход дерева с проверкой каждого узла. Возвращает корневой <svg>, если
 * нашёлся, — по нему потом читаются размеры.
 *
 * Обход рекурсивный: дерево SVG широкое, но неглубокое, и переполнения
 * стека ждать неоткуда — лимит на размер файла держит разметку в пределах
 * пары мегабайт.
 *
 * insideStyle отмечает, что мы внутри <style>: там текст — это правила
 * CSS, и у них свои опасности.
 */
function walk(nodes: XmlNode[], insideStyle = false): XmlNode | undefined {
  let svg: XmlNode | undefined;

  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ATTRIBUTES_KEY) {
        continue;
      }

      if (key === TEXT_KEY) {
        if (insideStyle) {
          assertSafeStyle(String(value));
        }
        continue;
      }

      const name = localName(key);

      if (FORBIDDEN_ELEMENTS.has(name)) {
        throw new ConversionError(
          `SVG содержит запрещённый элемент <${key}>: ` +
            'активное содержимое и внешние документы не принимаются',
        );
      }

      assertSafeAttributes(node[ATTRIBUTES_KEY], key);

      // Объявление <?xml?> и инструкции обработки детей не имеют
      if (Array.isArray(value)) {
        const nested = walk(value as XmlNode[], name === 'style');

        // Корень запоминаем первый попавшийся: вложенный <svg> — законный
        // элемент, но размеры документа задаёт внешний
        svg ??= name === 'svg' ? node : nested;
      }
    }
  }

  return svg;
}

/** Имя без префикса пространства имён и в нижнем регистре. */
function localName(key: string): string {
  const colon = key.lastIndexOf(':');

  return (colon < 0 ? key : key.slice(colon + 1)).toLowerCase();
}

/** Проверка атрибутов одного элемента. */
function assertSafeAttributes(
  attributes: Record<string, string> | undefined,
  element: string,
): void {
  if (!attributes) {
    return;
  }

  for (const [rawName, rawValue] of Object.entries(attributes)) {
    const name = localName(rawName);
    const value = String(rawValue);

    if (EVENT_ATTRIBUTE.test(name)) {
      throw new ConversionError(
        `SVG содержит обработчик события ${rawName} у <${element}>: ` +
          'это исполняемый код',
      );
    }

    if (LINK_ATTRIBUTES.has(name) && !SAFE_LINK.test(value.trim())) {
      throw new ConversionError(
        `SVG ссылается на внешний ресурс в ${rawName} у <${element}>: ` +
          'разрешены только ссылки внутрь документа (#id) и вложенные ' +
          'картинки (data:image/...)',
      );
    }

    // style как атрибут — те же правила CSS, что и в элементе <style>
    if (name === 'style') {
      assertSafeStyle(value);
    }
  }
}

function assertSafeStyle(css: string): void {
  if (UNSAFE_STYLE.test(css)) {
    throw new ConversionError(
      'SVG содержит стили с обращением наружу (@import, url(...) или ' +
        'javascript:): внешние ресурсы не загружаются',
    );
  }
}

/**
 * Собственный размер документа.
 *
 * Сначала атрибуты width и height, потом viewBox — так же поступает
 * браузер. Процентов и относительных единиц (em, ex, rem) в переносимом
 * виде здесь не бывает: они считаются от размера окна или шрифта, которых
 * при растеризации на сервере попросту нет. Такой размер считаем
 * отсутствующим и отдаём null.
 */
function readSize(root: XmlNode): SvgDocument {
  const attributes = root[ATTRIBUTES_KEY] ?? {};
  const width = toPixels(attributes['width']);
  const height = toPixels(attributes['height']);

  if (width !== null && height !== null) {
    return { width, height };
  }

  const box = readViewBox(attributes['viewBox'] ?? attributes['viewbox']);

  if (!box) {
    return { width, height };
  }

  // viewBox задаёт и размер, и пропорции: если своя длина есть только по
  // одной оси, вторую достраиваем по пропорциям, как делает браузер
  return {
    width:
      width ??
      (height === null ? box.width : (height * box.width) / box.height),
    height:
      height ??
      (width === null ? box.height : (width * box.height) / box.width),
  };
}

/** «12.5pt» → пиксели. null, если длины нет или она относительная. */
function toPixels(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }

  const match = LENGTH.exec(raw);

  if (!match) {
    return null;
  }

  // Единица не нашлась — она относительная (%, em, vw), и размера нет
  const factor = UNITS_IN_PIXELS[match[2]!.toLowerCase()];
  const value = factor === undefined ? 0 : Number(match[1]) * factor;

  return value > 0 ? value : null;
}

/** «min-x min-y width height» → размеры области. */
function readViewBox(
  raw: string | undefined,
): { width: number; height: number } | null {
  if (!raw) {
    return null;
  }

  // Разделителем в viewBox может быть и пробел, и запятая
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);

  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }

  const [, , width, height] = parts as [number, number, number, number];

  return width > 0 && height > 0 ? { width, height } : null;
}
