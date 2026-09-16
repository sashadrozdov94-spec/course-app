import sharp from 'sharp';
import { ConversionError } from './conversion-error.js';
import { CONVERTERS, findConverter } from './converters/index.js';
import type { ConversionSettings, ConvertOptions } from './image-converter.js';
import { ImageFormat } from './image-format.js';
import { detectFormat, formatByFilename } from './image-detector.js';
import { inspectSvg } from './svg/svg-document.js';

/**
 * Настройки, как их отдал бы ConfigService.
 *
 * Потолки нарочно низкие: так проверки на превышение видно на маленьких
 * картинках, а тесты не тратят секунды на отрисовку восьми тысяч пикселей.
 */
const SETTINGS: ConversionSettings = {
  maxWidth: 2_000,
  maxHeight: 2_000,
  maxPixels: 1_000_000,
  defaultSize: 256,
  timeoutMs: 30_000,
  defaultQuality: 80,
  defaultBackground: '#ffffff',
};

/** Короткая запись «сконвертируй вот это вот туда». */
async function convert(
  source: ImageFormat,
  target: ImageFormat,
  input: Buffer,
  options: ConvertOptions = {},
  settings: ConversionSettings = SETTINGS,
): Promise<Buffer> {
  const converter = findConverter(source, target);

  if (!converter) {
    throw new Error(`нет направления ${source} → ${target}`);
  }

  return converter.convert(input, options, settings);
}

/** Разметка SVG с заданными атрибутами корня. */
function svg(
  attributes: string,
  body = '<rect width="10" height="10"/>',
): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`,
  );
}

/** Растровый образец нужного размера и прозрачности. */
async function raster(
  format: ImageFormat,
  width = 40,
  height = 20,
  alpha = 1,
): Promise<Buffer> {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 40, b: 40, alpha },
    },
  });

  return format === ImageFormat.Png
    ? pipeline.png().toBuffer()
    : pipeline.jpeg().toBuffer();
}

describe('Набор направлений', () => {
  it('покрывает все четыре пары из ТЗ и не содержит лишних', () => {
    const directions = CONVERTERS.map((c) => `${c.source}→${c.target}`).sort();

    expect(directions).toEqual(
      ['png→jpeg', 'jpeg→png', 'svg→png', 'svg→jpeg'].sort(),
    );
  });

  it('не предлагает конвертацию формата в самого себя', () => {
    expect(findConverter('png', 'png')).toBeUndefined();
  });

  it('не предлагает векторизацию — это запрещено навсегда', () => {
    expect(findConverter('png', 'svg')).toBeUndefined();
    expect(findConverter('jpeg', 'svg')).toBeUndefined();
  });
});

describe('Определение исходного формата', () => {
  it('узнаёт PNG и JPEG по подписи, а не по имени файла', async () => {
    const png = await raster(ImageFormat.Png);
    const jpeg = await raster(ImageFormat.Jpeg);

    // Имена нарочно перепутаны: содержимое важнее расширения
    expect(detectFormat(png, formatByFilename('photo.jpg'))).toBe(
      ImageFormat.Png,
    );
    expect(detectFormat(jpeg, formatByFilename('photo.png'))).toBe(
      ImageFormat.Jpeg,
    );
  });

  it('узнаёт SVG вместе с объявлением XML и комментариями перед корнем', () => {
    const withPrologue = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- нарисовано вручную -->\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    );

    expect(detectFormat(withPrologue)).toBe(ImageFormat.Svg);
  });

  it('узнаёт SVG с меткой кодировки в начале файла', () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      svg('width="10" height="10"'),
    ]);

    expect(detectFormat(withBom)).toBe(ImageFormat.Svg);
  });

  it('не принимает за SVG чужую разметку с картинкой внутри', () => {
    const html = Buffer.from('<html><body><svg width="10"/></body></html>');

    expect(detectFormat(html)).toBeNull();
  });

  it('о незнакомом формате говорит «не знаю», а не угадывает', () => {
    expect(detectFormat(Buffer.from('GIF89a'))).toBeNull();
    expect(detectFormat(Buffer.alloc(0))).toBeNull();
  });

  it('верит расширению, когда содержимое молчит', () => {
    expect(detectFormat(Buffer.from('GIF89a'), ImageFormat.Png)).toBe(
      ImageFormat.Png,
    );
  });
});

describe('Растр в растр', () => {
  it('PNG → JPEG отдаёт настоящий JPEG того же размера', async () => {
    const out = await convert(
      ImageFormat.Png,
      ImageFormat.Jpeg,
      await raster(ImageFormat.Png, 40, 20),
    );
    const meta = await sharp(out).metadata();

    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([40, 20]);
  });

  it('JPEG → PNG отдаёт настоящий PNG того же размера', async () => {
    const out = await convert(
      ImageFormat.Jpeg,
      ImageFormat.Png,
      await raster(ImageFormat.Jpeg, 40, 20),
    );
    const meta = await sharp(out).metadata();

    expect(meta.format).toBe('png');
    expect([meta.width, meta.height]).toEqual([40, 20]);
  });

  it('прозрачность PNG кладётся на фон, а не чернеет в JPEG', async () => {
    const transparent = await raster(ImageFormat.Png, 8, 8, 0);

    const out = await convert(ImageFormat.Png, ImageFormat.Jpeg, transparent, {
      background: '#ffffff',
    });

    const { data } = await sharp(out)
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Полностью прозрачный PNG на белом фоне — белый JPEG, а не чёрный
    expect(data[0]).toBeGreaterThan(250);
    expect(data[1]).toBeGreaterThan(250);
    expect(data[2]).toBeGreaterThan(250);
  });

  it('качество влияет на размер файла', async () => {
    const source = await raster(ImageFormat.Png, 200, 200);

    const low = await convert(ImageFormat.Png, ImageFormat.Jpeg, source, {
      quality: 10,
    });
    const high = await convert(ImageFormat.Png, ImageFormat.Jpeg, source, {
      quality: 95,
    });

    expect(low.byteLength).toBeLessThan(high.byteLength);
  });

  it('повреждённый файл отклоняется, а не отдаётся наполовину', async () => {
    const broken = Buffer.concat([
      (await raster(ImageFormat.Png)).subarray(0, 30),
      Buffer.from('мусор вместо пикселей'),
    ]);

    await expect(
      convert(ImageFormat.Png, ImageFormat.Jpeg, broken),
    ).rejects.toThrow();
  });
});

describe('Растеризация SVG', () => {
  it('svg → png берёт размер из атрибутов', async () => {
    const out = await convert(
      ImageFormat.Svg,
      ImageFormat.Png,
      svg('width="120" height="60"'),
    );
    const meta = await sharp(out).metadata();

    expect(meta.format).toBe('png');
    expect([meta.width, meta.height]).toEqual([120, 60]);
  });

  it('берёт размер из viewBox, когда своих атрибутов нет', async () => {
    const out = await convert(
      ImageFormat.Svg,
      ImageFormat.Png,
      svg('viewBox="0 0 200 100"'),
    );
    const meta = await sharp(out).metadata();

    expect([meta.width, meta.height]).toEqual([200, 100]);
  });

  it('понимает единицы длины: 1in — это 96 пикселей', async () => {
    const out = await convert(
      ImageFormat.Svg,
      ImageFormat.Png,
      svg('width="1in" height="0.5in"'),
    );
    const meta = await sharp(out).metadata();

    expect([meta.width, meta.height]).toEqual([96, 48]);
  });

  it('подставляет размер из настроек, когда его нет нигде', async () => {
    const out = await convert(ImageFormat.Svg, ImageFormat.Png, svg(''));
    const meta = await sharp(out).metadata();

    expect([meta.width, meta.height]).toEqual([
      SETTINGS.defaultSize,
      SETTINGS.defaultSize,
    ]);
  });

  it('по одной заданной стороне достраивает вторую по пропорциям', async () => {
    const out = await convert(
      ImageFormat.Svg,
      ImageFormat.Png,
      svg('width="200" height="100"'),
      { width: 400 },
    );
    const meta = await sharp(out).metadata();

    expect([meta.width, meta.height]).toEqual([400, 200]);
  });

  it('обе заданные стороны выполняются буквально', async () => {
    const out = await convert(
      ImageFormat.Svg,
      ImageFormat.Png,
      svg('width="200" height="100"'),
      { width: 300, height: 300 },
    );
    const meta = await sharp(out).metadata();

    expect([meta.width, meta.height]).toEqual([300, 300]);
  });

  it('по умолчанию кладёт рисунок на белый холст', async () => {
    const out = await convert(
      ImageFormat.Svg,
      ImageFormat.Png,
      svg('width="4" height="4"', ''),
    );

    const { data } = await sharp(out)
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });

  it('прозрачный холст оставляет PNG прозрачным', async () => {
    const out = await convert(
      ImageFormat.Svg,
      ImageFormat.Png,
      svg('width="4" height="4"', ''),
      { background: 'transparent' },
    );

    const meta = await sharp(out).metadata();

    expect(meta.hasAlpha).toBe(true);
  });

  it('прозрачный холст для JPEG — отказ, а не догадка', async () => {
    await expect(
      convert(ImageFormat.Svg, ImageFormat.Jpeg, svg('width="4" height="4"'), {
        background: 'transparent',
      }),
    ).rejects.toThrow(ConversionError);
  });

  it('отказывает, когда заказанный размер больше разрешённого', async () => {
    await expect(
      convert(ImageFormat.Svg, ImageFormat.Png, svg('width="10" height="10"'), {
        width: SETTINGS.maxWidth + 1,
      }),
    ).rejects.toThrow(/больше допустимого/);
  });

  it('отказывает, когда собственный размер SVG больше разрешённого', async () => {
    await expect(
      convert(
        ImageFormat.Svg,
        ImageFormat.Png,
        svg('width="9000" height="10"'),
      ),
    ).rejects.toThrow(/больше допустимого/);
  });

  it('отказывает, когда пикселей больше разрешённого при годных сторонах', async () => {
    await expect(
      convert(ImageFormat.Svg, ImageFormat.Png, svg('width="10" height="10"'), {
        width: 1_500,
        height: 1_500,
      }),
    ).rejects.toThrow(/пикселей/);
  });

  it('рисует уменьшенно картинку с огромным собственным размером', async () => {
    // Своих 100000 × 100000 — сто миллиардов пикселей. Отрисовка идёт
    // сразу в уменьшенном масштабе, иначе упёрлась бы в лимит на первом же
    // шаге. Лимит здесь боевой: с тесным в этот случай не попасть
    const out = await convert(
      ImageFormat.Svg,
      ImageFormat.Png,
      svg('width="100000" height="100000"'),
      { width: 100, height: 100 },
      { ...SETTINGS, maxPixels: 40_000_000 },
    );

    const meta = await sharp(out).metadata();

    expect([meta.width, meta.height]).toEqual([100, 100]);
  });

  it('объясняет отказ, когда исходник не нарисовать и в наименьшем масштабе', async () => {
    // Масштаб отрисовки ограничен снизу 1/72 собственного размера: у такой
    // картинки это 13889 пикселей по стороне, и в лимит она не уложится
    // ни при каком заказанном размере
    await expect(
      convert(
        ImageFormat.Svg,
        ImageFormat.Png,
        svg('width="1000000" height="1000000"'),
        { width: 10, height: 10 },
      ),
    ).rejects.toThrow(/Собственный размер картинки/);
  });
});

describe('Параметры, которых направление не понимает', () => {
  it('растр в растр не принимает ширину и высоту', () => {
    expect(findConverter('png', 'jpeg')?.accepts).toEqual([
      'quality',
      'background',
    ]);
  });

  it('PNG на выходе не принимает ничего от формата', () => {
    expect(findConverter('jpeg', 'png')?.accepts).toEqual([]);
  });

  it('растеризация добавляет к параметрам формата свои', () => {
    expect([...(findConverter('svg', 'png')?.accepts ?? [])].sort()).toEqual(
      ['background', 'height', 'width'].sort(),
    );
    expect([...(findConverter('svg', 'jpeg')?.accepts ?? [])].sort()).toEqual(
      ['background', 'height', 'quality', 'width'].sort(),
    );
  });
});

describe('Безопасность SVG', () => {
  const unsafe: [string, string][] = [
    [
      'скрипт',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>',
    ],
    [
      'скрипт в другом регистре',
      '<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT>x()</SCRIPT></svg>',
    ],
    [
      'обработчик события',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><rect/></svg>',
    ],
    [
      'внешняя картинка',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://example.com/x.png"/></svg>',
    ],
    [
      'ссылка на файл сервера',
      '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="file:///etc/passwd"/></svg>',
    ],
    [
      'относительный путь наружу',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="../secret.png"/></svg>',
    ],
    [
      'внешняя сущность (XXE)',
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
        '<svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>',
    ],
    [
      'внешний стиль',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(http://e/x.css);</style></svg>',
    ],
    [
      'url наружу в атрибуте style',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(http://e/x)"/></svg>',
    ],
    [
      'врезка HTML',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><b/></foreignObject></svg>',
    ],
  ];

  it.each(unsafe)('отклоняет: %s', (_name, markup) => {
    expect(() => inspectSvg(markup)).toThrow(ConversionError);
  });

  it('пропускает обычную картинку со ссылками внутрь документа', () => {
    const safe =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<defs><linearGradient id="g"/></defs>' +
      '<style>.a{fill:url(#g)}</style>' +
      '<rect class="a" width="10" height="10"/>' +
      '<use href="#g"/></svg>';

    expect(inspectSvg(safe)).toEqual({ width: 10, height: 10 });
  });

  it('пропускает вложенную картинку в data:image', () => {
    const safe =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<image href="data:image/png;base64,iVBORw0KGgo="/></svg>';

    expect(() => inspectSvg(safe)).not.toThrow();
  });

  it('отклоняет поломанную разметку, а не разбирает её как получится', () => {
    expect(() =>
      inspectSvg('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'),
    ).toThrow(ConversionError);
  });

  it('размер в процентах считает отсутствующим: окна на сервере нет', () => {
    const relative =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"/>';

    expect(inspectSvg(relative)).toEqual({ width: null, height: null });
  });

  it('по проценту и viewBox берёт размер из viewBox', () => {
    const mixed =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 30 15"/>';

    expect(inspectSvg(mixed)).toEqual({ width: 30, height: 15 });
  });
});
