import { FORMAT_BY_EXTENSION, ImageFormat } from './image-format.js';

/**
 * Сколько байт от начала файла хватает, чтобы узнать формат.
 *
 * Растровым хватило бы восьми — их подпись стоит в самом начале. Запас
 * нужен для SVG: перед корневым тегом законно стоят объявление <?xml?>,
 * комментарии и переводы строк, и у выгрузок из редакторов эта шапка
 * бывает довольно длинной. Читать ради опознания весь файл незачем.
 */
const PROBE_BYTES = 4096;

/** Подпись PNG из спецификации: \x89PNG\r\n\x1a\n. */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Начало JPEG: маркер SOI (FFD8) и начало следующего маркера (FF).
 *
 * Двух байт SOI мало — они встречаются и в случайных данных. Третий байт
 * обязателен по стандарту: сразу за SOI идёт маркер, а любой маркер
 * начинается с FF.
 */
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** Байт-порядок в начале файла. Не данные, а метка кодировки. */
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Корневой тег SVG: <svg с границей имени после.
 *
 * Граница обязательна, иначе под правило попал бы вымышленный <svgfoo>.
 * Привязка к началу — тоже: <svg> где-то в середине чужой разметки
 * означает документ другого формата с картинкой внутри, а не картинку.
 */
const SVG_ROOT = /^<svg[\s/>]/i;

/**
 * Что законно стоит перед корневым тегом XML: объявление, комментарий,
 * инструкция обработки, пробелы. Всё остальное означает, что это не SVG.
 *
 * DOCTYPE в список намеренно не входит: документ с ним отклоняется как
 * небезопасный (см. svg/svg-document.ts), и притворяться, что мы его не
 * узнали, не нужно — узнаём и отвечаем по существу.
 */
const XML_PROLOGUE = /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)*/;

/**
 * Определение исходного формата.
 *
 * ТЗ разрешает опираться на содержимое или расширение. Смотрим сначала в
 * содержимое: расширение задаёт клиент, и оно запросто врёт — файл
 * photo.png может оказаться выгрузкой JPEG. Ошибка здесь дороже, чем
 * кажется: декодер получил бы не тот файл и вернул невнятную ошибку
 * вместо честного «формат не тот».
 *
 * У растровых форматов есть подпись в первых байтах, и разночтений тут не
 * бывает. SVG подписи не имеет — это обычный XML, — поэтому его признак
 * составной: после законной шапки XML должен встретиться корневой тег
 * <svg>. Этого достаточно для опознания; настоящая проверка разметки идёт
 * дальше, при разборе документа, и дублировать её здесь незачем.
 *
 * Расширение остаётся последним доводом — на случай форматов без подписи,
 * которых у нас пока нет, но которые появятся вместе с новым форматом.
 */
export function detectFormat(
  buffer: Buffer,
  extensionHint?: ImageFormat,
): ImageFormat | null {
  if (buffer.length === 0) {
    return null;
  }

  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return ImageFormat.Png;
  }

  if (buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return ImageFormat.Jpeg;
  }

  if (looksLikeSvg(buffer)) {
    return ImageFormat.Svg;
  }

  return extensionHint ?? null;
}

/**
 * Похоже ли начало файла на документ SVG.
 *
 * Метка кодировки снимается: редакторы Windows ставят её и перед XML, а
 * для разбора это посторонний символ. Двоичные форматы до сюда не
 * доходят — их уже опознали по подписи.
 */
function looksLikeSvg(buffer: Buffer): boolean {
  const start = buffer.subarray(0, BOM.length).equals(BOM) ? BOM.length : 0;
  // latin1 вместо utf8: нам нужны только теги ASCII, а разрезанный по
  // границе PROBE_BYTES многобайтовый символ не должен превратиться в U+FFFD
  const head = buffer.subarray(start, start + PROBE_BYTES).toString('latin1');
  const body = head.slice(XML_PROLOGUE.exec(head)?.[0].length ?? 0);

  // Корневым тегом должен быть именно <svg>: <html> с картинкой внутри
  // или произвольный XML — это не изображение
  return SVG_ROOT.test(body);
}

/** Формат по расширению в имени файла. undefined — имени нет или оно чужое. */
export function formatByFilename(name: string | null): ImageFormat | undefined {
  if (!name) {
    return undefined;
  }

  const dot = name.lastIndexOf('.');

  return dot < 0
    ? undefined
    : FORMAT_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
}
