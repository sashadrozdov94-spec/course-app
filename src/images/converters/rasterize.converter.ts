import { ConversionError } from '../conversion-error.js';
import {
  type ConversionSettings,
  type ConvertOptions,
  ImageConverter,
  type OptionName,
} from '../image-converter.js';
import { ImageFormat } from '../image-format.js';
import { inspectSvg, type SvgDocument } from '../svg/svg-document.js';
import { flattenOnto, open, writerFor } from './encode.js';

/**
 * Разрешение отрисовки по умолчанию: 72 точки на дюйм.
 *
 * В этих единицах librsvg принимает масштаб, и при 72 он рисует картинку
 * в её собственном размере. Отношением density к этому числу мы и задаём
 * масштаб отрисовки — см. densityFor.
 */
const BASE_DENSITY = 72;

/** Границы density, которые принимает библиотека растеризации. */
const MIN_DENSITY = 1;
const MAX_DENSITY = 100_000;

/**
 * Растеризация вектора: svg → png, svg → jpeg (п. 1.2 ТЗ).
 *
 * Класс один на все растровые цели по той же причине, что и у
 * перекодирования: отрисовка не зависит от того, чем потом сжимать
 * пиксели. Новый растровый формат даст новое направление из SVG сам.
 *
 * Обратного направления нет и не будет: п. 1.2 ТЗ запрещает векторизацию
 * навсегда. Запрет не в коде, а в устройстве — направления строятся
 * «вектор → растр», и пары в другую сторону просто неоткуда взять.
 */
export class RasterizeConverter extends ImageConverter {
  readonly source = ImageFormat.Svg;

  constructor(readonly target: ImageFormat) {
    super();
  }

  /**
   * К параметрам целевого формата растеризация добавляет свои.
   *
   * width и height — размер холста, которого у вектора нет. background —
   * цвет этого холста: под разметкой пусто, и чем заполнить пустоту,
   * знает только заказчик. Для PNG формат сам по себе фон не требует,
   * поэтому background приходит именно отсюда.
   */
  get accepts(): readonly OptionName[] {
    return [
      ...new Set<OptionName>([
        ...writerFor(this.target).accepts,
        'width',
        'height',
        'background',
      ]),
    ];
  }

  async convert(
    input: Buffer,
    options: ConvertOptions,
    settings: ConversionSettings,
  ): Promise<Buffer> {
    // Разбор и проверка безопасности идут до растеризации: в отрисовщик
    // не должен попасть файл, который мы не одобрили
    const document = inspectSvg(decode(input));
    const size = resolveSize(document, options, settings);

    const density = densityFor(document, size);

    assertDrawable(document, density, settings);

    const pipeline = open(input, settings, { density });

    // fit: 'fill' — растянуть ровно до заказанного размера. Если клиент
    // задал обе стороны и они не в пропорции исходника, картинка
    // растянется: заказаны были именно эти размеры, и подгонять их под
    // пропорции (обрезая или добавляя поля) он не просил
    const drawn = flattenOnto(
      pipeline.resize(size.width, size.height, { fit: 'fill' }),
      options,
      settings,
    );

    return writerFor(this.target).encode(drawn, options, settings).toBuffer();
  }
}

/** Размер выходного растра в пикселях. */
interface Size {
  width: number;
  height: number;
}

/**
 * Байты → разметка.
 *
 * SVG — текст, и ТЗ предполагает UTF-8. Некорректные последовательности
 * Node заменяет символом U+FFFD, поэтому проверяем результат: файл в
 * cp1251 иначе молча превратился бы в картинку с мусором вместо подписей.
 */
function decode(input: Buffer): string {
  const text = input.toString('utf8');
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  if (withoutBom.includes('�')) {
    throw new ConversionError('SVG не в кодировке UTF-8 либо повреждён');
  }

  return withoutBom;
}

/**
 * Какого размера рисовать (п. 1.3.1 ТЗ).
 *
 * Правило: заказанная сторона, иначе собственная, иначе значение из
 * настроек. ТЗ оставляет открытым случай, когда задана ровно одна
 * сторона, — здесь вторая достраивается по пропорциям исходника.
 * Понимать это место буквально («вторая берётся собственная») значило бы
 * молча растягивать картинку всякий раз, когда клиент просит вписать её в
 * ширину, — а просит он обычно именно так.
 *
 * Пропорции берутся из самого документа, поэтому достроить вторую сторону
 * можно только если у документа есть собственный размер. Нет его — берём
 * значение из настроек: это честнее выдумывания квадрата.
 */
function resolveSize(
  document: SvgDocument,
  options: ConvertOptions,
  settings: ConversionSettings,
): Size {
  const ratio =
    document.width !== null && document.height !== null
      ? document.width / document.height
      : null;

  const { width: askedWidth, height: askedHeight } = options;

  const width =
    askedWidth ??
    (askedHeight !== undefined && ratio !== null
      ? askedHeight * ratio
      : (document.width ?? settings.defaultSize));

  const height =
    askedHeight ??
    (askedWidth !== undefined && ratio !== null
      ? askedWidth / ratio
      : (document.height ?? settings.defaultSize));

  return assertWithinLimits(
    { width: Math.round(width), height: Math.round(height) },
    settings,
  );
}

/**
 * Итоговые размеры против потолков из конфигурации (п. 1.3.1 ТЗ).
 *
 * Сторон и числа пикселей — двух проверок, а не одной: стороны
 * ограничивают форму, а произведение — объём работы. 8000 × 8000
 * укладывается в обе стороны, но это 64 миллиона пикселей и четверть
 * гигабайта памяти под несжатый растр. Полоска 12000 × 10, наоборот,
 * пикселей почти не требует, но выходит за ширину.
 */
function assertWithinLimits(size: Size, settings: ConversionSettings): Size {
  if (size.width < 1 || size.height < 1) {
    throw new ConversionError('Размер выходного изображения меньше пикселя');
  }

  if (size.width > settings.maxWidth || size.height > settings.maxHeight) {
    throw new ConversionError(
      `Размер ${size.width}×${size.height} больше допустимого ` +
        `${settings.maxWidth}×${settings.maxHeight}: укажите width и height ` +
        'в options',
    );
  }

  if (size.width * size.height > settings.maxPixels) {
    throw new ConversionError(
      `В изображении ${size.width}×${size.height} больше ` +
        `${settings.maxPixels} пикселей — это слишком много для отрисовки`,
    );
  }

  return size;
}

/**
 * Влезет ли сама отрисовка в лимит пикселей.
 *
 * Проверка итогового размера этого не покрывает: рисуется картинка не в
 * заказанном размере, а в ближайшем, который позволяет масштаб, — и
 * уменьшается уже потом. Обычно разница незаметна, но у исходника с
 * собственной шириной в сотню тысяч пикселей масштаб упирается в нижнюю
 * границу, и промежуточный растр остаётся большим.
 *
 * Без этой проверки такой файл всё равно не прошёл бы — отрисовка упёрлась
 * бы в тот же лимит внутри библиотеки, — но клиент получил бы сообщение
 * про пиксели вообще, не понимая, что дело в самой картинке, а не в
 * заказанном размере. Считаем сами и объясняем.
 */
function assertDrawable(
  document: SvgDocument,
  density: number,
  settings: ConversionSettings,
): void {
  if (document.width === null || document.height === null) {
    return;
  }

  const scale = density / BASE_DENSITY;
  const pixels = document.width * scale * (document.height * scale);

  if (pixels > settings.maxPixels) {
    throw new ConversionError(
      `Собственный размер картинки ${Math.round(document.width)}×` +
        `${Math.round(document.height)} слишком велик: даже в наименьшем ` +
        'масштабе отрисовки получается больше ' +
        `${settings.maxPixels} пикселей`,
    );
  }
}

/**
 * Масштаб отрисовки.
 *
 * Отрисовать вектор сразу в нужном размере, а не нарисовать в
 * собственном и потом растянуть, — единственный способ получить чёткий
 * результат: у вектора нет «родного» разрешения, и увеличенный вдвое
 * растр остаётся мыльным, откуда бы он ни взялся.
 *
 * У этого же есть вторая, менее очевидная польза. Картинка с width =
 * 100000 в собственном размере — десять миллиардов пикселей, и отрисовка
 * упёрлась бы в лимит ещё до того, как дело дошло до уменьшения. С
 * масштабом отрисовки такой файл рисуется сразу маленьким, и уменьшать
 * потом почти нечего.
 *
 * Границы density заданы библиотекой. Нижняя (1, то есть 1/72 от
 * собственного размера) означает, что совсем уж чудовищный исходник всё
 * равно нарисуется крупнее заказанного и будет уменьшен обычным образом;
 * если и этого окажется много, отрисовка упрётся в лимит пикселей и
 * вернётся честная ошибка.
 */
function densityFor(document: SvgDocument, size: Size): number {
  // Собственного размера нет — масштабировать не от чего: пусть
  // отрисовщик решает сам, а нужный размер даст resize
  if (document.width === null) {
    return BASE_DENSITY;
  }

  const scale = (BASE_DENSITY * size.width) / document.width;

  return Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, scale));
}
