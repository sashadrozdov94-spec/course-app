import { type INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Repository } from 'typeorm';
// Приложение берётся из собранного dist, а не из src.
// Причина в рабочем потоке: ConversionRunner ищет convert.worker.js рядом
// с собой, а под vitest модули живут в src/ в виде .ts — файла .js там
// нет, поток не стартует, и все направления падали бы одинаково. Собранный
// код — это ровно то, что запускается в бою, так что тест ещё и честнее.
// Сборку делает скрипт test:e2e перед запуском.
import { AppModule } from '../dist/app.module.js';
import { TokenService } from '../dist/auth/token.service.js';
import { RateLimitGuard } from '../dist/common/guards/rate-limit.guard.js';
import { FileConversion } from '../dist/convert/entities/file-conversion.entity.js';
import { User, UserStatus } from '../dist/users/entities/user.entity.js';

/**
 * Конвертация файлов через настоящий endpoint.
 *
 * Юнит-тесты в src/convert/convert.spec.ts проверяют сами преобразования;
 * здесь проверяется всё остальное: охранник, multipart, определение
 * формата по загруженному файлу, заголовки ответа, коды ошибок, работа в
 * отдельном потоке и запись истории в базу.
 *
 * Ограничитель частоты подменён заглушкой: на запросе висит потолок в 20
 * обращений в минуту с адреса, а в этом файле их больше. Сам ограничитель
 * к конвертации отношения не имеет и проверяется отдельно.
 */
describe('Конвертация файлов (e2e)', () => {
  let app: INestApplication;
  let users: Repository<User>;
  let history: Repository<FileConversion>;
  let cookie: string;
  let userId: string;

  // Образцы одних и тех же данных в четырёх форматах
  const CSV = 'name,age\r\nAlice,30\r\nBob,25\r\n';
  const JSON_DOC = '{"people":[{"name":"Alice","age":30}]}';
  const XML_DOC = '<people><person><name>Alice</name></person></people>';
  const YAML_DOC = 'people:\n  - name: Alice\n    age: 30\n';

  const SAMPLES: Record<string, { body: string; filename: string }> = {
    csv: { body: CSV, filename: 'data.csv' },
    json: { body: JSON_DOC, filename: 'data.json' },
    xml: { body: XML_DOC, filename: 'data.xml' },
    yaml: { body: YAML_DOC, filename: 'data.yaml' },
  };

  /** Загрузить файл на конвертацию от имени вошедшего пользователя. */
  function upload(source: string, target: string) {
    const sample = SAMPLES[source]!;

    return request(app.getHttpServer())
      .post('/api/convert')
      .set('Cookie', cookie)
      .field('targetFormat', target)
      .attach('file', Buffer.from(sample.body, 'utf8'), sample.filename);
  }

  beforeAll(async () => {
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
    history = moduleFixture.get(getRepositoryToken(FileConversion));

    // Готовый активный пользователь: проверяем конвертацию, а не
    // регистрацию с подтверждением почты — у неё свои тесты
    const user = await users.save(
      users.create({
        email: `convert-e2e-${Date.now()}@example.com`,
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
    await history.delete({ userId });
    await users.delete({ id: userId });
    await app.close();
  });

  describe('Доступ', () => {
    it('без токена отвечает 401', async () => {
      await request(app.getHttpServer())
        .post('/api/convert')
        .field('targetFormat', 'json')
        .attach('file', Buffer.from(CSV, 'utf8'), 'data.csv')
        .expect(401);
    });

    it('отдаёт список направлений вошедшему пользователю', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/convert/formats')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body).toEqual(
        expect.arrayContaining([
          { source: 'csv', target: ['json', 'xml', 'yaml'] },
          { source: 'json', target: ['csv', 'xml', 'yaml'] },
          { source: 'xml', target: ['csv', 'json', 'yaml'] },
          { source: 'yaml', target: ['csv', 'json', 'xml'] },
        ]),
      );
    });
  });

  describe('Все 12 направлений', () => {
    it('CSV → JSON', async () => {
      const response = await upload('csv', 'json').expect(200);

      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="converted.json"',
      );
      expect(JSON.parse(response.text)).toEqual([
        { name: 'Alice', age: '30' },
        { name: 'Bob', age: '25' },
      ]);
    });

    it('CSV → XML', async () => {
      const response = await upload('csv', 'xml').expect(200);

      expect(response.headers['content-type']).toContain('application/xml');
      expect(response.text).toContain('<name>Alice</name>');
      expect(response.text.match(/<item>/g)).toHaveLength(2);
    });

    it('CSV → YAML', async () => {
      const response = await upload('csv', 'yaml').expect(200);

      expect(response.headers['content-type']).toContain('application/yaml');
      expect(response.text).toBe(
        '- name: Alice\n  age: "30"\n- name: Bob\n  age: "25"\n',
      );
    });

    it('JSON → CSV', async () => {
      const response = await upload('json', 'csv').expect(200);

      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="converted.csv"',
      );
      expect(response.text).toBe('name,age\r\nAlice,30\r\n');
    });

    it('JSON → XML', async () => {
      const response = await upload('json', 'xml').expect(200);

      expect(response.text).toContain('<people>');
      expect(response.text).toContain('<name>Alice</name>');
    });

    it('JSON → YAML', async () => {
      const response = await upload('json', 'yaml').expect(200);

      expect(response.text).toBe('people:\n  - name: Alice\n    age: 30\n');
    });

    it('XML → JSON', async () => {
      const response = await upload('xml', 'json').expect(200);

      expect(JSON.parse(response.text)).toEqual({
        people: { person: { name: 'Alice' } },
      });
    });

    it('XML → CSV', async () => {
      const response = await upload('xml', 'csv').expect(200);

      expect(response.text).toBe('name\r\nAlice\r\n');
    });

    it('XML → YAML', async () => {
      const response = await upload('xml', 'yaml').expect(200);

      expect(response.text).toBe('people:\n  person:\n    name: Alice\n');
    });

    it('YAML → JSON', async () => {
      const response = await upload('yaml', 'json').expect(200);

      expect(JSON.parse(response.text)).toEqual({
        people: [{ name: 'Alice', age: 30 }],
      });
    });

    it('YAML → CSV', async () => {
      const response = await upload('yaml', 'csv').expect(200);

      expect(response.text).toBe('name,age\r\nAlice,30\r\n');
    });

    it('YAML → XML', async () => {
      const response = await upload('yaml', 'xml').expect(200);

      expect(response.text).toContain('<people>');
      expect(response.text).toContain('<age>30</age>');
    });
  });

  describe('Определение формата по содержимому', () => {
    it('верит содержимому, а не расширению в имени файла', async () => {
      // XML внутри, но имя говорит «json»: должен победить XML
      const response = await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'json')
        .attach('file', Buffer.from(XML_DOC, 'utf8'), 'на-самом-деле.json')
        .expect(200);

      expect(JSON.parse(response.text)).toEqual({
        people: { person: { name: 'Alice' } },
      });
    });

    it('опирается на расширение там, где содержимое неоднозначно', async () => {
      // Одна колонка без запятых — это и корректный CSV, и корректный YAML
      const response = await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'json')
        .attach('file', Buffer.from('name\r\nAlice\r\n', 'utf8'), 'one.csv')
        .expect(200);

      expect(JSON.parse(response.text)).toEqual([{ name: 'Alice' }]);
    });

    it('снимает BOM, оставленный редактором Windows', async () => {
      const withBom = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(JSON_DOC, 'utf8'),
      ]);

      const response = await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'yaml')
        .attach('file', withBom, 'bom.json')
        .expect(200);

      expect(response.text).toBe('people:\n  - name: Alice\n    age: 30\n');
    });
  });

  describe('Отказы', () => {
    it('415, если формат файла не распознан', async () => {
      await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'json')
        .attach('file', Buffer.from('просто текст', 'utf8'), 'note.txt')
        .expect(415);
    });

    it('415, если направление ведёт в тот же формат', async () => {
      await upload('json', 'json').expect(415);
    });

    it('400, если целевой формат не из списка', async () => {
      await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'pdf')
        .attach('file', Buffer.from(CSV, 'utf8'), 'data.csv')
        .expect(400);
    });

    it('400, если файла нет вовсе', async () => {
      await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'json')
        .expect(400);
    });

    it('400 на синтаксически неверном файле', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'yaml')
        .attach('file', Buffer.from('{"a":}', 'utf8'), 'broken.json')
        .expect(400);

      expect(response.body.message).toMatch(/Некорректный JSON/);
    });

    it('400 на пустом файле', async () => {
      await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'json')
        .attach('file', Buffer.from('   \n', 'utf8'), 'empty.csv')
        .expect(400);
    });

    it('400 на файле не в UTF-8', async () => {
      // «Привет» в cp1251: в UTF-8 эти байты не складываются в символы
      const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);

      await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'json')
        .attach('file', cp1251, 'cp1251.csv')
        .expect(400);
    });

    it('400 на XML с DOCTYPE: внешние сущности запрещены', async () => {
      const xxe =
        '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
        '<root>&xxe;</root>';

      const response = await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'json')
        .attach('file', Buffer.from(xxe, 'utf8'), 'xxe.xml')
        .expect(400);

      expect(response.body.message).toMatch(/DOCTYPE/);
    });

    it('413, если файл больше лимита для своего формата', async () => {
      // Лимит JSON — 5 МиБ; берём строковый документ чуть больше
      const big = `"${'a'.repeat(5 * 1024 * 1024 + 16)}"`;

      await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'yaml')
        .attach('file', Buffer.from(big, 'utf8'), 'big.json')
        .expect(413);
    }, 30_000);

    it('не отдаёт частичный файл при ошибке', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'csv')
        .attach('file', Buffer.from('[]', 'utf8'), 'empty-array.json')
        .expect(400);

      expect(response.headers['content-disposition']).toBeUndefined();
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body.message).toMatch(/Нет ни одной строки/);
    });
  });

  describe('История конвертаций', () => {
    it('пишет и удачи, и отказы, не сохраняя содержимое файла', async () => {
      const records = await history.find({ where: { userId } });

      expect(records.length).toBeGreaterThan(0);

      const success = records.find(
        (row) => row.sourceFormat === 'csv' && row.targetFormat === 'yaml',
      );

      expect(success).toBeDefined();
      expect(success!.status).toBe('success');
      expect(success!.statusCode).toBe(200);
      expect(success!.sourceBytes).toBe(Buffer.byteLength(CSV));
      expect(success!.targetBytes).toBeGreaterThan(0);
      expect(success!.durationMs).toBeGreaterThanOrEqual(0);

      const failure = records.find((row) => row.status === 'error');

      expect(failure).toBeDefined();
      expect([400, 413, 415]).toContain(failure!.statusCode);

      // Содержимого файлов в истории быть не должно
      const dump = JSON.stringify(records);

      expect(dump).not.toContain('Alice');
      expect(dump).not.toContain('Bob');
    });
  });
});
