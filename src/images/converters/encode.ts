import sharp, { type Sharp, type SharpOptions } from 'sharp';
import { ConversionError } from '../conversion-error.js';
import type {
  ConversionSettings,
  ConvertOptions,
  OptionName,
} from '../image-converter.js';
import type { ImageFormat } from '../image-format.js';
import { ImageFormat as Format } from '../image-format.js';

/**
 * Запись одного растрового формата.
 *
 * Здесь единственное место, где живут особенности формата на выходе: что
 * JPEG не хранит прозрачность, а PNG не знает слова «качество». Новый
 * растровый формат — это одна запись в WRITERS и одна строка в
 * RASTER_FORMATS; направления с ним соберутся сами.
 */
interface RasterWriter {
  /**
   * Какие поля options формат понимает на выходе.
   *
   * Список именно формата, а не направления: направление добавит к нему
   * своё (растеризация — ширину и высоту), но убрать отсюда ничего не
   * может.
   */
  accepts: readonly OptionName[];

  encode(
    pipeline: Sharp,
    options: ConvertOptions,
    settings: ConversionSettings,
  ): Sharp;
}

/** Цвет фона: #rgb, #rgba, #rrggbb, #rrggbbaa или слово transparent. */
export const BACKGROUND =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent)$/i;

/** Фон, сквозь который видно всё. */
const TRANSPARENT = 'transparent';

const WRITERS: Readonly<Partial<Record<ImageFormat, RasterWriter>>> = {
  /**
   * PNG: сжатие без потерь, прозрачность сохраняется.
   *
   * quality не поддерживается намеренно: у PNG нет потерь, которыми можно
   * было бы поступиться, а параметр с таким именем в libvips означает
   * совсем другое — переход к палитре, то есть потерю цветов. Клиент,
   * пославший quality для PNG, получит отказ вместо тихо испорченных
   * оттенков.
   *
   * background тоже ни при чём: подкладывать фон под прозрачность не надо,
   * PNG хранит её как есть. Исключение — растеризация, где фон задаёт
   * холст; это добавляет уже направление.
   */
  [Format.Png]: {
    accepts: [],
    encode: (pipeline) => pipeline.png(),
  },

  /**
   * JPEG: сжатие с потерями, прозрачности нет.
   *
   * flatten обязателен: без него полупрозрачные пиксели PNG или SVG
   * попали бы в JPEG чёрными — альфа-канал отбрасывается, а цвет под ним
   * остаётся неопределённым. Это и есть «корректная обработка
   * альфа-канала» из п. 1.6 ТЗ: прозрачное подкладывается на фон, а не
   * теряется.
   */
  [Format.Jpeg]: {
    accepts: ['quality', 'background'],
    encode: (pipeline, options, settings) =>
      pipeline
        .flatten({ background: opaqueBackground(options, settings) })
        .jpeg({ quality: options.quality ?? settings.defaultQuality }),
  },
};

/**
 * Как писать целевой формат.
 *
 * Отсутствие записи — не ошибка клиента, а расхождение внутри приложения:
 * направления строятся только для форматов из RASTER_FORMATS, и если
 * формат попал туда, но писателя не завёл, узнать об этом лучше сразу и с
 * понятным текстом.
 */
export function writerFor(format: ImageFormat): RasterWriter {
  const writer = WRITERS[format];

  if (!writer) {
    throw new Error(`Для формата ${format} не задана запись`);
  }

  return writer;
}

/**
 * Начало конвейера: чтение исходного файла с включёнными предохранителями.
 *
 * limitInputPixels — защита от «декомпрессионной бомбы» (п. 1.4 и 1.6 ТЗ):
 * файл может весить десятки килобайт и разворачиваться в изображение на
 * сотни мегапикселей, потому что однотонный растр сжимается почти в ноль.
 * Лимит на размер файла такого не ловит, а несжатый растр занимает по
 * четыре байта на пиксель.
 *
 * timeout останавливает саму обработку внутри libvips (п. 1.6 ТЗ). Это
 * важнее, чем кажется: обещание на стороне Node можно бросить по времени,
 * но работа в пуле потоков от этого не прекратится — поток так и останется
 * занят, и несколько таких запросов забьют пул целиком.
 *
 * failOn: 'error' — отклоняем повреждённые файлы, но терпим мелкие
 * придирки вроде лишних байт в конце: такие файлы открываются всюду, и
 * отказ по ним выглядел бы капризом.
 */
export function open(
  input: Buffer,
  settings: ConversionSettings,
  extra: SharpOptions = {},
): Sharp {
  return sharp(input, {
    limitInputPixels: settings.maxPixels,
    failOn: 'error',
    ...extra,
  }).timeout({ seconds: Math.ceil(settings.timeoutMs / 1000) });
}

/**
 * Подложить холст под прозрачные пиксели.
 *
 * Нужно растеризации: у вектора нет собственного фона, и п. 1.3.1 ТЗ
 * назначает холстом background со значением по умолчанию #ffffff.
 *
 * Прозрачный холст оставляет изображение как есть — только так SVG можно
 * превратить в PNG с прозрачностью. Для JPEG такой холст не пройдёт
 * дальше: его писатель откажет, потому что альфа-канала в формате нет.
 */
export function flattenOnto(
  pipeline: Sharp,
  options: ConvertOptions,
  settings: ConversionSettings,
): Sharp {
  const color = background(options, settings);

  return isTransparent(color)
    ? pipeline
    : pipeline.flatten({ background: color });
}

/** Цвет холста: из options, иначе из настроек (по ТЗ — #ffffff). */
function background(
  options: ConvertOptions,
  settings: ConversionSettings,
): string {
  return options.background ?? settings.defaultBackground;
}

/**
 * Непрозрачный цвет холста для форматов без альфа-канала.
 *
 * Прозрачный фон для JPEG — противоречивое требование, и выполнить его
 * нельзя никак: выйдет либо чёрный прямоугольник, либо белый, и обоих
 * клиент не заказывал. Поэтому отказ с объяснением, а не догадка.
 */
function opaqueBackground(
  options: ConvertOptions,
  settings: ConversionSettings,
): string {
  const color = background(options, settings);

  if (isTransparent(color)) {
    throw new ConversionError(
      'JPEG не хранит прозрачность: укажите непрозрачный цвет в options.background',
    );
  }

  return color;
}

/** Есть ли в цвете прозрачность: слово transparent или неполная альфа. */
function isTransparent(color: string): boolean {
  if (color.toLowerCase() === TRANSPARENT) {
    return true;
  }

  // #rgba и #rrggbbaa: последний разряд (или пара) — альфа. У #rgb и
  // #rrggbb её нет, такой цвет непрозрачен по определению
  const alpha =
    color.length === 5
      ? color.slice(4).repeat(2)
      : color.length === 9
        ? color.slice(7)
        : null;

  return alpha !== null && Number.parseInt(alpha, 16) < 255;
}
