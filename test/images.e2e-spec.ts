import { type INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import sharp from 'sharp';
import request from 'supertest';
import type { Repository } from 'typeorm';
// Приложение берётся из собранного dist, а не из src — так же, как в
// тесте текстовой конвертации: собранный код это ровно то, что запускается
// в бою. Сборку делает скрипт test:e2e перед запуском.
import { AppModule } from '../dist/app.module.js';
import { TokenService } from '../dist/auth/token.service.js';
import { RateLimitGuard } from '../dist/common/guards/rate-limit.guard.js';
import { User, UserStatus } from '../dist/users/entities/user.entity.js';

/**
 * Трансформация изображений через настоящий endpoint.
 *
 * Юнит-тесты в src/images/images.spec.ts проверяют сами преобразования,
 * разбор SVG и определение формата; здесь проверяется всё остальное:
 * охранник, multipart, разбор options из строки, заголовки ответа и коды
 * ошибок.
 *
 * Ограничитель частоты подменён заглушкой: на запросе висит потолок в 20
 * обращений в минуту с адреса, а в этом файле их больше. Сам ограничитель
 * к конвертации отношения не имеет и проверяется отдельно.
 */
describe('Трансформация изображений (e2e)', () => {
  let app: INestApplication;
  let users: Repository<User>;
  let cookie: string;
  let userId: string;

  /** Образцы: два растра и вектор. */
  let PNG: Buffer;
  let JPEG: Buffer;

  const SVG = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">' +
      '<rect width="40" height="20" fill="#c82828"/></svg>',
  );

  /** Загрузить изображение на конвертацию от имени вошедшего пользователя. */
  function upload(
    file: Buffer,
    filename: string,
    targetFormat: string,
    options?: Record<string, unknown>,
  ) {
    const call = request(app.getHttpServer())
      .post('/api/images/convert')
      .set('Cookie', cookie)
      .field('targetFormat', targetFormat);

    if (options) {
      call.field('options', JSON.stringify(options));
    }

    return call.attach('file', file, filename);
  }

  beforeAll(async () => {
    PNG = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 4,
        background: { r: 200, g: 40, b: 40, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    JPEG = await sharp(PNG).jpeg().toBuffer();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    // main.ts делает то же самое: без этого cookie с токеном не прочитать
    app.use(cookieParser());
    await app.init();

    users = moduleFixture.get(getRepositoryToken(User));

    // Готовый активный пользователь: проверяем конвертацию, а не
    // регистрацию с подтверждением почты — у неё свои тесты
    const user = await users.save(
      users.create({
        email: `images-e2e-${Date.now()}@example.com`,
        passwordHash: 'не используется в этом тесте',
        status: UserStatus.Active,
        emailVerifiedAt: new Date(),
      }),
    );

    userId = user.id;

    const tokens = await moduleFixture
      .get(TokenService)
      .issuePair({ sub: user.id, email: user.email });

    cookie = `access_token=${tokens.accessToken}`;
  }, 60_000);

  afterAll(async () => {
    await users.delete({ id: userId });
    await app.close();
  });

  describe('Доступ', () => {
    it('без токена отвечает 401', async () => {
      await request(app.getHttpServer())
        .post('/api/images/convert')
        .field('targetFormat', 'jpeg')
        .attach('file', PNG, 'picture.png')
        .expect(401);
    });

    it('список направлений закрыт от неаутентифицированных', async () => {
      await request(app.getHttpServer())
        .get('/api/images/convert/formats')
        .expect(401);
    });

    it('отдаёт список направлений вошедшему пользователю', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/images/convert/formats')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body).toEqual(
        expect.arrayContaining([
          { source: 'png', target: ['jpeg'] },
          { source: 'jpeg', target: ['png'] },
          { source: 'svg', target: ['png', 'jpeg'] },
        ]),
      );
    });

    it('в списке нет ни одного направления в svg', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/images/convert/formats')
        .set('Cookie', cookie)
        .expect(200);

      const targets = (response.body as { target: string[] }[]).flatMap(
        (row) => row.target,
      );

      expect(targets).not.toContain('svg');
    });
  });

  describe('Все четыре направления', () => {
    it('PNG → JPEG', async () => {
      const response = await upload(PNG, 'picture.png', 'jpeg').expect(200);

      expect(response.headers['content-type']).toContain('image/jpeg');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="converted.jpeg"',
      );

      const meta = await sharp(response.body as Buffer).metadata();

      expect(meta.format).toBe('jpeg');
      expect([meta.width, meta.height]).toEqual([40, 20]);
    });

    it('JPEG → PNG', async () => {
      const response = await upload(JPEG, 'picture.jpg', 'png').expect(200);

      expect(response.headers['content-type']).toContain('image/png');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="converted.png"',
      );

      const meta = await sharp(response.body as Buffer).metadata();

      expect(meta.format).toBe('png');
    });

    it('SVG → PNG', async () => {
      const response = await upload(SVG, 'drawing.svg', 'png').expect(200);

      const meta = await sharp(response.body as Buffer).metadata();

      expect(meta.format).toBe('png');
      expect([meta.width, meta.height]).toEqual([40, 20]);
    });

    it('SVG → JPEG', async () => {
      const response = await upload(SVG, 'drawing.svg', 'jpeg').expect(200);

      const meta = await sharp(response.body as Buffer).metadata();

      expect(meta.format).toBe('jpeg');
    });
  });

  describe('Параметры', () => {
    it('width при растеризации задаёт размер, высота идёт по пропорциям', async () => {
      const response = await upload(SVG, 'drawing.svg', 'png', {
        width: 400,
      }).expect(200);

      const meta = await sharp(response.body as Buffer).metadata();

      expect([meta.width, meta.height]).toEqual([400, 200]);
    });

    it('quality уменьшает размер JPEG', async () => {
      const low = await upload(PNG, 'p.png', 'jpeg', { quality: 5 }).expect(
        200,
      );
      const high = await upload(PNG, 'p.png', 'jpeg', { quality: 95 }).expect(
        200,
      );

      expect((low.body as Buffer).byteLength).toBeLessThan(
        (high.body as Buffer).byteLength,
      );
    });

    it('параметр, которого направление не понимает, — 400', async () => {
      const response = await upload(JPEG, 'p.jpg', 'png', {
        quality: 50,
      }).expect(400);

      expect(JSON.stringify(response.body)).toContain('quality');
    });

    it('незнакомое поле в options — 400', async () => {
      await upload(PNG, 'p.png', 'jpeg', { heigth: 10 }).expect(400);
    });

    it('options не в JSON — 400', async () => {
      await request(app.getHttpServer())
        .post('/api/images/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'jpeg')
        .field('options', 'width=10')
        .attach('file', PNG, 'p.png')
        .expect(400);
    });

    it('качество вне 1–100 — 400', async () => {
      await upload(PNG, 'p.png', 'jpeg', { quality: 0 }).expect(400);
      await upload(PNG, 'p.png', 'jpeg', { quality: 101 }).expect(400);
    });

    it('размер больше разрешённого — 400', async () => {
      await upload(SVG, 'drawing.svg', 'png', { width: 100_000 }).expect(400);
    });
  });

  describe('Отказы', () => {
    it('без файла — 400', async () => {
      await request(app.getHttpServer())
        .post('/api/images/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'jpeg')
        .expect(400);
    });

    it('неизвестный целевой формат — 400', async () => {
      await upload(PNG, 'p.png', 'gif').expect(400);
    });

    it('векторизация запрещена навсегда — 400', async () => {
      const response = await upload(PNG, 'p.png', 'svg').expect(400);

      expect(JSON.stringify(response.body)).toContain('не поддерживается');
    });

    it('неподдерживаемый формат файла — 415', async () => {
      const gif = Buffer.from('GIF89a и дальше не важно что');

      await upload(gif, 'picture.gif', 'png').expect(415);
    });

    it('битый PNG — 400, а не половина картинки', async () => {
      const broken = Buffer.concat([
        PNG.subarray(0, 30),
        Buffer.from('мусор вместо пикселей'),
      ]);

      await upload(broken, 'p.png', 'jpeg').expect(400);
    });

    it('SVG со скриптом отклоняется', async () => {
      const withScript = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
          '<script>fetch("http://example.com")</script></svg>',
      );

      const response = await upload(withScript, 'x.svg', 'png').expect(400);

      expect(JSON.stringify(response.body)).toContain('script');
    });

    it('SVG с внешней сущностью отклоняется (XXE)', async () => {
      const xxe = Buffer.from(
        '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
          '<text>&xxe;</text></svg>',
      );

      await upload(xxe, 'x.svg', 'png').expect(400);
    });

    it('SVG с внешней картинкой отклоняется', async () => {
      const external = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
          '<image href="http://example.com/x.png"/></svg>',
      );

      await upload(external, 'x.svg', 'png').expect(400);
    });

    it('превышение лимита размера — 413', async () => {
      // Лимит для SVG — 2 МиБ по умолчанию; набиваем разметку комментарием
      const padding = 'ж'.repeat(1_200_000);
      const huge = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
          `<!--${padding}--><rect width="10" height="10"/></svg>`,
      );

      await upload(huge, 'big.svg', 'png').expect(413);
    });
  });

  describe('Определение формата по содержимому', () => {
    it('не верит расширению: PNG с именем .jpg конвертируется как PNG', async () => {
      // png → jpeg поддерживается, jpeg → jpeg — нет. Если бы формат брали
      // из имени, ответ был бы 400
      await upload(PNG, 'обманка.jpg', 'jpeg').expect(200);
    });
  });
});
