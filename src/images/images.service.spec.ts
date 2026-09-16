import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import sharp from 'sharp';
import type {
  HistoryWriteService,
  TransformationRecord,
} from '../transformations/history-write.service.js';
import { ImageFormat } from './image-format.js';
import { ImagesService } from './images.service.js';

const USER = 'user-1';

/** Настройки: потолки низкие, чтобы превышения ловились на мелочи. */
const ENV: Record<string, number | string> = {
  IMAGE_MAX_PNG_BYTES: 100_000,
  IMAGE_MAX_JPEG_BYTES: 100_000,
  IMAGE_MAX_SVG_BYTES: 300,
  IMAGE_MAX_WIDTH: 2_000,
  IMAGE_MAX_HEIGHT: 2_000,
  IMAGE_MAX_PIXELS: 1_000_000,
  IMAGE_DEFAULT_SIZE: 256,
  IMAGE_TIMEOUT_MS: 30_000,
  IMAGE_JPEG_QUALITY: 80,
  IMAGE_BACKGROUND: '#ffffff',
};

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">' +
    '<rect width="40" height="20" fill="red"/></svg>',
);

/** Загруженный файл, как его отдаёт multer. */
function upload(buffer: Buffer, originalname?: string) {
  return { buffer, originalname, size: buffer.byteLength };
}

function setup() {
  const records: TransformationRecord[] = [];

  const history = {
    record: (entry: TransformationRecord) => {
      records.push(entry);
      return Promise.resolve();
    },
  } as unknown as HistoryWriteService;

  return {
    records,
    service: new ImagesService(history, {
      get: (key: string) => ENV[key],
    } as unknown as ConfigService<Env, true>),
  };
}

let png: Buffer;
let jpeg: Buffer;

beforeAll(async () => {
  png = await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 4,
      background: { r: 200, g: 40, b: 40, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  jpeg = await sharp(png).jpeg().toBuffer();
});

describe('Список направлений', () => {
  it('содержит все четыре пары и ни одной в svg', () => {
    const directions = setup().service.supportedFormats();

    expect(directions).toContainEqual({ source: 'png', target: ['jpeg'] });
    expect(directions).toContainEqual({
      source: 'svg',
      target: ['png', 'jpeg'],
    });
    expect(directions.flatMap((row) => row.target)).not.toContain('svg');
  });
});

describe('Конвертация изображения', () => {
  it('png → jpeg отдаёт настоящий JPEG', async () => {
    const { service } = setup();

    const result = await service.convert(
      USER,
      upload(png, 'p.png'),
      ImageFormat.Jpeg,
      {},
    );

    expect(result.mime).toBe('image/jpeg');
    expect(result.filename).toBe('converted.jpeg');
    expect((await sharp(result.body).metadata()).format).toBe('jpeg');
  });

  it('svg → png растеризуется в собственный размер', async () => {
    const { service } = setup();

    const result = await service.convert(
      USER,
      upload(SVG, 'd.svg'),
      ImageFormat.Png,
      {},
    );
    const meta = await sharp(result.body).metadata();

    expect([meta.width, meta.height]).toEqual([40, 20]);
  });

  it('пишет в историю успех с форматами и размером', async () => {
    const { service, records } = setup();

    await service.convert(USER, upload(jpeg, 'p.jpg'), ImageFormat.Png, {});

    expect(records[0]).toMatchObject({
      type: 'image',
      sourceFormat: 'jpeg',
      targetFormat: 'png',
      statusCode: 200,
    });
    expect(records[0]!.resultSize).toBeGreaterThan(0);
  });

  it('по просьбе передаёт результат на сохранение', async () => {
    const { service, records } = setup();

    await service.convert(
      USER,
      upload(png, 'p.png'),
      ImageFormat.Jpeg,
      {},
      true,
    );

    expect(records[0]!.save).toMatchObject({
      name: 'converted.jpeg',
      mime: 'image/jpeg',
      extension: 'jpeg',
    });
  });

  describe('Отказы', () => {
    it('пустой файл — 400', async () => {
      const { service, records } = setup();

      await expect(
        service.convert(USER, upload(Buffer.alloc(0)), ImageFormat.Png, {}),
      ).rejects.toThrow(BadRequestException);

      expect(records[0]).toMatchObject({ statusCode: 400 });
    });

    it('неизвестный формат — 415', async () => {
      const { service, records } = setup();

      await expect(
        service.convert(
          USER,
          upload(Buffer.from('GIF89a'), 'x.gif'),
          ImageFormat.Png,
          {},
        ),
      ).rejects.toThrow(UnsupportedMediaTypeException);

      expect(records[0]).toMatchObject({ sourceFormat: null, statusCode: 415 });
    });

    it('превышение лимита размера — 413', async () => {
      const { service, records } = setup();
      const padded = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
          `<!--${'ж'.repeat(400)}--></svg>`,
      );

      await expect(
        service.convert(USER, upload(padded, 'd.svg'), ImageFormat.Png, {}),
      ).rejects.toThrow(PayloadTooLargeException);

      expect(records[0]).toMatchObject({ statusCode: 413 });
    });

    it('векторизация запрещена — 400 с объяснением', async () => {
      const { service } = setup();

      await expect(
        service.convert(USER, upload(png, 'p.png'), ImageFormat.Svg, {}),
      ).rejects.toThrow(/растр в вектор/);
    });

    it('битый файл — 400, а не половина картинки', async () => {
      const { service } = setup();
      const broken = Buffer.concat([
        png.subarray(0, 30),
        Buffer.from('мусор вместо пикселей'),
      ]);

      await expect(
        service.convert(USER, upload(broken, 'p.png'), ImageFormat.Jpeg, {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('SVG со скриптом отклоняется с понятным текстом', async () => {
      const { service } = setup();
      const unsafe = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
          '<script>x()</script></svg>',
      );

      await expect(
        service.convert(USER, upload(unsafe, 'x.svg'), ImageFormat.Png, {}),
      ).rejects.toThrow(/script/);
    });
  });

  describe('Параметры, которых направление не понимает', () => {
    it('quality для PNG — 400 со списком принимаемых', async () => {
      const { service } = setup();

      await expect(
        service.convert(USER, upload(jpeg, 'p.jpg'), ImageFormat.Png, {
          quality: 50,
        }),
      ).rejects.toThrow(/не принимает параметры: quality/);
    });

    it('ширина при перекодировании растра — 400', async () => {
      const { service } = setup();

      await expect(
        service.convert(USER, upload(png, 'p.png'), ImageFormat.Jpeg, {
          width: 100,
        }),
      ).rejects.toThrow(/width/);
    });

    it('те же параметры при растеризации принимаются', async () => {
      const { service } = setup();

      const result = await service.convert(
        USER,
        upload(SVG, 'd.svg'),
        ImageFormat.Png,
        {
          width: 80,
        },
      );
      const meta = await sharp(result.body).metadata();

      expect([meta.width, meta.height]).toEqual([80, 40]);
    });

    it('размер больше потолка — 400', async () => {
      const { service, records } = setup();

      await expect(
        service.convert(USER, upload(SVG, 'd.svg'), ImageFormat.Png, {
          width: 5_000,
        }),
      ).rejects.toThrow(/больше допустимого/);

      expect(records[0]).toMatchObject({ statusCode: 400 });
    });

    it('прозрачный фон для JPEG — 400, а не чёрный прямоугольник', async () => {
      const { service } = setup();

      await expect(
        service.convert(USER, upload(SVG, 'd.svg'), ImageFormat.Jpeg, {
          background: 'transparent',
        }),
      ).rejects.toThrow(/прозрачность/);
    });
  });

  it('формат определяется по содержимому, а не по имени', async () => {
    const { service, records } = setup();

    // png → jpeg поддерживается, jpeg → jpeg — нет: по имени вышел бы отказ
    await service.convert(
      USER,
      upload(png, 'обманка.jpg'),
      ImageFormat.Jpeg,
      {},
    );

    expect(records[0]!.sourceFormat).toBe('png');
  });
});
