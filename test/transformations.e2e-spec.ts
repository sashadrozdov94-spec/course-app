import { type INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Repository } from 'typeorm';
// Приложение берётся из собранного dist — как и в остальных e2e.
// Сборку делает скрипт test:e2e перед запуском.
import { AppModule } from '../dist/app.module.js';
import { TokenService } from '../dist/auth/token.service.js';
import { RateLimitGuard } from '../dist/common/guards/rate-limit.guard.js';
import { Grant } from '../dist/rbac/entities/grant.entity.js';
import { Permission } from '../dist/rbac/entities/permission.entity.js';
import { Role } from '../dist/rbac/entities/role.entity.js';
import { RbacConfigService } from '../dist/rbac/rbac-config.service.js';
import { Transformation } from '../dist/transformations/entities/transformation.entity.js';
import { FileStorage } from '../dist/storage/file-storage.js';
import { HistoryRetentionService } from '../dist/transformations/history-retention.service.js';
import {
  TRANSFORMATIONS_ACTIONS,
  TRANSFORMATIONS_PERMISSION,
  TransformationStatus,
  TransformationType,
} from '../dist/transformations/transformation.js';
import { User, UserStatus } from '../dist/users/entities/user.entity.js';

/**
 * Просмотр истории трансформаций через настоящие endpoint'ы.
 *
 * Юнит-тесты в src/transformations/history.spec.ts проверяют разбор
 * параметров и курсор; здесь — то, что видно только на живой базе:
 * выборка, порядок, страницы, фильтры и, главное, доступ.
 *
 * Записи истории кладём прямо в таблицу, а не гоняем конвертацию: нас
 * интересует чтение, а получить нужный набор записей с нужными датами
 * через настоящие загрузки было бы и дольше, и менее управляемо. Что
 * конвертация действительно пишет сюда, проверяют её собственные тесты.
 *
 * Ограничитель частоты подменён заглушкой: запросов в файле больше, чем
 * он разрешает, а к самой истории он отношения не имеет.
 */
describe('История трансформаций (e2e)', () => {
  let app: INestApplication;
  let users: Repository<User>;
  let history: Repository<Transformation>;
  let roles: Repository<Role>;
  let permissions: Repository<Permission>;
  let grants: Repository<Grant>;

  /** Обычный пользователь, чья история наполнена записями. */
  let owner: { id: string; cookie: string };
  /** Посторонний: прав нет, своей истории нет. */
  let stranger: { id: string; cookie: string };
  /** Администратор с правом transformations@history_admin. */
  let admin: { id: string; cookie: string };
  /** Тот, кто сам конвертирует и сохраняет результаты. */
  let saver: { id: string; cookie: string };

  /** То же хранилище, что и у приложения: проверяем файлы на диске. */
  let storage: FileStorage;

  let roleId: string;
  let permissionId: string;

  /**
   * Начало отсчёта для записей: час назад.
   *
   * Именно «час назад», а не какая-нибудь круглая дата в прошлом. Записи
   * старше срока хранения убирает HistoryRetentionService, и он заходит
   * при каждом старте приложения — в том числе в соседних файлах тестов,
   * которые идут параллельно. Фиксированная дата из прошлого года
   * исчезала бы у нас из-под ног в середине проверки.
   */
  const BASE = new Date(Date.now() - 60 * 60 * 1000);

  /**
   * Номер, которого точно нет.
   *
   * Настоящий UUID четвёртой версии, а не просто похожая строка: иначе
   * запрос отсеется проверкой формата ещё на входе, и до поиска
   * пользователя дело не дойдёт — проверять мы будем не то, что хотели.
   */
  const MISSING_USER_ID = '11111111-2222-4333-8444-555555555555';

  /**
   * Набор записей владельца: три файловых и две картиночных, с
   * известными датами и статусами.
   *
   * Порядок в массиве — от старых к новым, чтобы ожидания читались
   * сверху вниз; ответ придёт наоборот, новыми вперёд.
   */
  const ENTRIES = [
    {
      type: TransformationType.File,
      sourceFormat: 'csv',
      targetFormat: 'json',
      ok: true,
    },
    {
      type: TransformationType.File,
      sourceFormat: 'xml',
      targetFormat: 'yaml',
      ok: false,
    },
    {
      type: TransformationType.Image,
      sourceFormat: 'png',
      targetFormat: 'jpeg',
      ok: true,
    },
    {
      type: TransformationType.File,
      sourceFormat: 'json',
      targetFormat: 'csv',
      ok: true,
    },
    {
      type: TransformationType.Image,
      sourceFormat: 'svg',
      targetFormat: 'png',
      ok: true,
    },
  ] as const;

  /** Создать активного пользователя и войти за него. */
  async function makeUser(
    tokens: TokenService,
    label: string,
  ): Promise<{ id: string; cookie: string }> {
    const user = await users.save(
      users.create({
        email: `history-${label}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}@example.com`,
        passwordHash: 'не используется в этом тесте',
        status: UserStatus.Active,
        emailVerifiedAt: new Date(),
      }),
    );

    const pair = await tokens.issuePair({ sub: user.id, email: user.email });

    return { id: user.id, cookie: `access_token=${pair.accessToken}` };
  }

  /** Запрос своей истории. */
  function own(who: { cookie: string }, query: Record<string, string> = {}) {
    return request(app.getHttpServer())
      .get('/api/transformations/history')
      .set('Cookie', who.cookie)
      .query(query);
  }

  /** Запрос истории указанного пользователя. */
  function forUser(
    who: { cookie: string },
    userId: string,
    query: Record<string, string> = {},
  ) {
    return request(app.getHttpServer())
      .get(`/admin/users/${userId}/transformations/history`)
      .set('Cookie', who.cookie)
      .query(query);
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
    history = moduleFixture.get(getRepositoryToken(Transformation));
    roles = moduleFixture.get(getRepositoryToken(Role));
    permissions = moduleFixture.get(getRepositoryToken(Permission));
    grants = moduleFixture.get(getRepositoryToken(Grant));

    const tokens = moduleFixture.get(TokenService);

    owner = await makeUser(tokens, 'owner');
    stranger = await makeUser(tokens, 'stranger');
    admin = await makeUser(tokens, 'admin');
    saver = await makeUser(tokens, 'saver');

    storage = moduleFixture.get(FileStorage);

    // ── Право на чужую историю ──
    // Заводим его так же, как это делает сид: разрешение с действиями,
    // роль и назначение. Без строки в permissions право не существует для
    // RbacService, и окно отвечало бы 403 даже администратору.
    let permission = await permissions.findOneBy({
      name: TRANSFORMATIONS_PERMISSION,
    });

    permission ??= await permissions.save(
      permissions.create({
        name: TRANSFORMATIONS_PERMISSION,
        actions: Object.values(TRANSFORMATIONS_ACTIONS),
      }),
    );

    permissionId = permission.id;

    const role = await roles.save(
      roles.create({
        name: `history-admin-${Date.now()}`,
        description: 'Роль для проверки права на чужую историю',
      }),
    );

    roleId = role.id;

    await grants.save(
      grants.create({
        roleId: role.id,
        permissionId: permission.id,
        actions: [TRANSFORMATIONS_ACTIONS.HistoryAdmin],
      }),
    );

    const adminUser = await users.findOne({
      where: { id: admin.id },
      relations: { roles: true },
    });

    adminUser!.roles = [role];
    await users.save(adminUser!);

    // Правила изменились в базе напрямую — перечитываем конфигурацию,
    // иначе приложение работало бы по старой
    await moduleFixture.get(RbacConfigService).reload();

    // ── Записи истории ──
    for (const [index, entry] of ENTRIES.entries()) {
      await history.save(
        history.create({
          userId: owner.id,
          type: entry.type,
          sourceName: `секретное-имя-${index}.dat`,
          sourceFormat: entry.sourceFormat,
          targetFormat: entry.targetFormat,
          status: entry.ok
            ? TransformationStatus.Success
            : TransformationStatus.Error,
          statusCode: entry.ok ? 200 : 415,
          fileSize: 100 + index,
          resultSize: entry.ok ? 200 + index : null,
          error: entry.ok ? null : 'направление не поддерживается',
          durationMs: 5 + index,
          // Минута между записями: порядок «новые сверху» должен быть
          // однозначным, а не зависеть от того, как лягут миллисекунды
          createdAt: new Date(BASE.getTime() + index * 60_000),
        }),
      );
    }
  }, 60_000);

  afterAll(async () => {
    await history.delete({ userId: owner.id });
    // Файлы сохранившего убираем вместе с его записями, чтобы тест не
    // оставлял мусор на диске
    for (const row of await history.find({ where: { userId: saver.id } })) {
      if (row.fileId) {
        await storage.remove(row.fileId).catch(() => undefined);
      }
    }
    await history.delete({ userId: saver.id });
    await grants.delete({ roleId, permissionId });
    await users.delete({ id: owner.id });
    await users.delete({ id: stranger.id });
    await users.delete({ id: admin.id });
    await users.delete({ id: saver.id });
    await roles.delete({ id: roleId });
    await app.close();
  });

  describe('Доступ', () => {
    it('своя история без токена — 401', async () => {
      await request(app.getHttpServer())
        .get('/api/transformations/history')
        .expect(401);
    });

    it('чужая история без токена — 401', async () => {
      await request(app.getHttpServer())
        .get(`/admin/users/${owner.id}/transformations/history`)
        .expect(401);
    });

    it('посторонний в чужую историю — 403', async () => {
      await forUser(stranger, owner.id).expect(403);
    });

    it('администратор с правом — 200', async () => {
      const response = await forUser(admin, owner.id).expect(200);

      expect(response.body.items).toHaveLength(ENTRIES.length);
    });

    it('свою историю через административное окно можно и без права', async () => {
      await forUser(stranger, stranger.id).expect(200);
    });

    it('администратор о несуществующем пользователе — 404', async () => {
      await forUser(admin, MISSING_USER_ID).expect(404);
    });

    it('посторонний о несуществующем пользователе — всё равно 403', async () => {
      // Иначе по разнице между 404 и 403 можно было бы перебором
      // выяснять, какие номера пользователей существуют
      await forUser(stranger, MISSING_USER_ID).expect(403);
    });

    it('мусор вместо номера пользователя — 400', async () => {
      await forUser(admin, 'не-номер').expect(400);
    });
  });

  describe('Содержимое списка', () => {
    it('отдаёт записи обоих модулей в одном списке', async () => {
      const response = await own(owner).expect(200);
      const types = new Set(
        (response.body.items as { type: string }[]).map((item) => item.type),
      );

      expect(types).toEqual(new Set(['file', 'image']));
    });

    it('новые записи идут первыми', async () => {
      const response = await own(owner).expect(200);
      const dates = (response.body.items as { createdAt: string }[]).map(
        (item) => Date.parse(item.createdAt),
      );

      expect(dates).toEqual([...dates].sort((a, b) => b - a));
    });

    it('в строке есть все поля из ТЗ', async () => {
      const response = await own(owner, { status: 'success' }).expect(200);
      const item = response.body.items[0];

      expect(item).toMatchObject({
        id: expect.any(String),
        type: expect.any(String),
        sourceFormat: expect.any(String),
        targetFormat: expect.any(String),
        status: 'success',
        fileSize: expect.any(Number),
        durationMs: expect.any(Number),
        createdAt: expect.any(String),
      });
    });

    it('errorCode есть только у отказов', async () => {
      const failures = await own(owner, { status: 'error' }).expect(200);
      const successes = await own(owner, { status: 'success' }).expect(200);

      expect(failures.body.items[0].errorCode).toBe('415');
      expect(successes.body.items[0]).not.toHaveProperty('errorCode');
    });

    it('не раскрывает имя исходного файла', async () => {
      // Через административное окно видны чужие записи, и имена чужих
      // файлов там ни к чему
      const response = await forUser(admin, owner.id).expect(200);

      expect(JSON.stringify(response.body)).not.toContain('секретное-имя');
    });

    it('у чужого человека своя история пуста, а не чужая', async () => {
      const response = await own(stranger).expect(200);

      expect(response.body.items).toEqual([]);
      expect(response.body.nextCursor).toBeNull();
    });
  });

  describe('Фильтры', () => {
    it('по виду трансформации', async () => {
      const response = await own(owner, { type: 'image' }).expect(200);

      expect(response.body.items).toHaveLength(2);
      expect(
        (response.body.items as { type: string }[]).every(
          (item) => item.type === 'image',
        ),
      ).toBe(true);
    });

    it('по статусу', async () => {
      const response = await own(owner, { status: 'error' }).expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].sourceFormat).toBe('xml');
    });

    it('по исходному и целевому формату', async () => {
      const bySource = await own(owner, { sourceFormat: 'csv' }).expect(200);
      const byTarget = await own(owner, { targetFormat: 'png' }).expect(200);

      expect(bySource.body.items).toHaveLength(1);
      expect(byTarget.body.items).toHaveLength(1);
      expect(byTarget.body.items[0].sourceFormat).toBe('svg');
    });

    it('по периоду, включая обе границы', async () => {
      const from = new Date(BASE.getTime() + 60_000).toISOString();
      const to = new Date(BASE.getTime() + 3 * 60_000).toISOString();

      const response = await own(owner, {
        createdAtFrom: from,
        createdAtTo: to,
      }).expect(200);

      // Записи с 1-й по 3-ю включительно
      expect(response.body.items).toHaveLength(3);
    });

    it('фильтры складываются друг с другом', async () => {
      const response = await own(owner, {
        type: 'file',
        status: 'success',
      }).expect(200);

      expect(response.body.items).toHaveLength(2);
    });

    it('перевёрнутый период — 400, а не пустой список', async () => {
      await own(owner, {
        createdAtFrom: '2025-02-01',
        createdAtTo: '2025-01-01',
      }).expect(400);
    });

    it('незнакомый параметр — 400', async () => {
      await own(owner, { staus: 'error' }).expect(400);
    });

    it('недопустимое значение фильтра — 400', async () => {
      await own(owner, { type: 'video' }).expect(400);
      await own(owner, { sourceFormat: 'gif' }).expect(400);
      await own(owner, { limit: '1000' }).expect(400);
    });
  });

  describe('Постраничный обход', () => {
    it('проходит всю историю без повторов и пропусков', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      // Ограничитель на случай ошибки в курсоре: бесконечный цикл в
      // тесте хуже упавшего теста
      let guard = 0;

      do {
        const response = await own(
          owner,
          cursor ? { limit: '2', cursor } : { limit: '2' },
        ).expect(200);

        expect(response.body.items.length).toBeLessThanOrEqual(2);

        seen.push(
          ...(response.body.items as { id: string }[]).map((item) => item.id),
        );
        cursor = response.body.nextCursor as string | null;
        guard += 1;
      } while (cursor && guard < 10);

      expect(cursor).toBeNull();
      expect(seen).toHaveLength(ENTRIES.length);
      expect(new Set(seen).size).toBe(ENTRIES.length);
    });

    it('курсор сохраняет фильтр: он задаётся заново каждым запросом', async () => {
      const first = await own(owner, { type: 'file', limit: '1' }).expect(200);

      expect(first.body.nextCursor).not.toBeNull();

      const second = await own(owner, {
        type: 'file',
        limit: '1',
        cursor: first.body.nextCursor,
      }).expect(200);

      expect(second.body.items[0].type).toBe('file');
      expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    });

    it('на последней странице курсора нет', async () => {
      const response = await own(owner, { limit: '100' }).expect(200);

      expect(response.body.nextCursor).toBeNull();
    });

    it('одни и те же параметры дают один и тот же ответ', async () => {
      // Идемпотентность из п. 1.6 ТЗ
      const first = await own(owner, { limit: '3' }).expect(200);
      const second = await own(owner, { limit: '3' }).expect(200);

      expect(second.body).toEqual(first.body);
    });

    it('испорченный курсор — 400', async () => {
      await own(owner, { cursor: 'не курсор' }).expect(400);
    });
  });

  describe('Сохранение результата и скачивание', () => {
    /** Сконвертировать CSV с флагом save и вернуть номер записи истории. */
    async function convertAndSave(
      who: { cookie: string },
      save: boolean,
    ): Promise<{ itemId: string; body: string }> {
      const response = await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', who.cookie)
        .field('targetFormat', 'json')
        .field('save', String(save))
        .attach('file', Buffer.from('name,age\r\nAlice,30\r\n'), 'data.csv')
        .expect(200);

      const list = await own(who, { limit: '1' }).expect(200);

      return { itemId: list.body.items[0].id, body: response.text };
    }

    /** Скачать свой файл по номеру записи. */
    function download(who: { cookie: string }, itemId: string) {
      return request(app.getHttpServer())
        .get(`/api/transformations/history/${itemId}/download`)
        .set('Cookie', who.cookie);
    }

    /** Скачать файл пользователя через административное окно. */
    function downloadAs(
      who: { cookie: string },
      userId: string,
      itemId: string,
    ) {
      return request(app.getHttpServer())
        .get(
          `/admin/users/${userId}/transformations/history/${itemId}/download`,
        )
        .set('Cookie', who.cookie);
    }

    it('save=true даёт запись, из которой файл скачивается', async () => {
      const { itemId, body } = await convertAndSave(saver, true);
      const list = await own(saver, { limit: '1' }).expect(200);

      expect(list.body.items[0].saved).toBe(true);
      expect(list.body.items[0].expiresAt).not.toBeNull();

      const response = await download(saver, itemId).expect(200);

      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="converted.json"',
      );
      expect(response.headers['content-type']).toContain('application/json');
      // Скачанное совпадает с тем, что клиент получил при конвертации
      expect(response.text).toBe(body);
    });

    it('скачивание идемпотентно: второй раз тот же файл', async () => {
      const { itemId } = await convertAndSave(saver, true);

      const first = await download(saver, itemId).expect(200);
      const second = await download(saver, itemId).expect(200);

      expect(second.text).toBe(first.text);
    });

    it('без save у записи нет файла — 404', async () => {
      const { itemId } = await convertAndSave(saver, false);
      const list = await own(saver, { limit: '1' }).expect(200);

      expect(list.body.items[0].saved).toBe(false);
      expect(list.body.items[0].expiresAt).toBeNull();

      await download(saver, itemId).expect(404);
    });

    it('картинки сохраняются так же, как файлы', async () => {
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10">' +
          '<rect width="20" height="10" fill="red"/></svg>',
      );

      await request(app.getHttpServer())
        .post('/api/images/convert')
        .set('Cookie', saver.cookie)
        .field('targetFormat', 'png')
        .field('save', 'true')
        .attach('file', svg, 'drawing.svg')
        .expect(200);

      const list = await own(saver, { limit: '1', type: 'image' }).expect(200);

      expect(list.body.items[0].saved).toBe(true);

      const response = await download(saver, list.body.items[0].id).expect(200);

      expect(response.headers['content-type']).toContain('image/png');
      expect((response.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
    });

    it('чужой файл посторонним не отдаётся — 403', async () => {
      const { itemId } = await convertAndSave(saver, true);

      await download(stranger, itemId).expect(403);
    });

    it('администратор с правом скачивает чужой файл', async () => {
      const { itemId, body } = await convertAndSave(saver, true);

      const response = await downloadAs(admin, saver.id, itemId).expect(200);

      expect(response.text).toBe(body);
    });

    it('посторонний через административное окно — 403', async () => {
      const { itemId } = await convertAndSave(saver, true);

      await downloadAs(stranger, saver.id, itemId).expect(403);
    });

    it('чужая запись под своим номером в адресе — 404', async () => {
      // Защита от IDOR: подставить свой номер к чужой записи не поможет
      const { itemId } = await convertAndSave(saver, true);

      await downloadAs(admin, admin.id, itemId).expect(404);
    });

    it('скачивание без токена — 401', async () => {
      const { itemId } = await convertAndSave(saver, true);

      await request(app.getHttpServer())
        .get(`/api/transformations/history/${itemId}/download`)
        .expect(401);
    });

    it('несуществующая запись — 404', async () => {
      await download(saver, MISSING_USER_ID).expect(404);
    });

    it('мусор вместо номера записи — 400', async () => {
      await request(app.getHttpServer())
        .get('/api/transformations/history/not-a-uuid/download')
        .set('Cookie', saver.cookie)
        .expect(400);
    });

    it('истёкший файл — 410, и в списке он больше не предлагается', async () => {
      const { itemId } = await convertAndSave(saver, true);

      await history.update(
        { id: itemId },
        { expiresAt: new Date(Date.now() - 1000) },
      );

      await download(saver, itemId).expect(410);

      const list = await own(saver, { limit: '1' }).expect(200);

      expect(list.body.items[0].saved).toBe(false);
    });

    it('пропавший из хранилища файл — 404, а не 500', async () => {
      const { itemId } = await convertAndSave(saver, true);
      const record = await history.findOneBy({ id: itemId });

      await storage.remove(record!.fileId!);

      await download(saver, itemId).expect(404);
    });
  });

  describe('Срок хранения', () => {
    it('убирает записи старше срока и не трогает свежие', async () => {
      const retention = app.get(HistoryRetentionService);

      const stale = await history.save(
        history.create({
          userId: owner.id,
          type: TransformationType.File,
          sourceName: null,
          sourceFormat: 'csv',
          targetFormat: 'json',
          status: TransformationStatus.Success,
          statusCode: 200,
          fileSize: 1,
          resultSize: 1,
          error: null,
          durationMs: 1,
          // Заведомо за пределами любого разумного срока хранения
          createdAt: new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000),
        }),
      );

      const before = await own(owner, { limit: '100' }).expect(200);

      await retention.purge();

      expect(await history.findOneBy({ id: stale.id })).toBeNull();

      // Свежие записи на месте: убирают по возрасту, а не подряд
      const after = await own(owner, { limit: '100' }).expect(200);

      expect(after.body.items).toHaveLength(ENTRIES.length);
      expect(before.body.items.length).toBe(ENTRIES.length + 1);
    });

    it('вместе с записью убирает и сохранённый файл', async () => {
      const retention = app.get(HistoryRetentionService);

      // Настоящая сохранённая трансформация, а не строка в базе: проверяем
      // как раз то, что файл на диске не переживает свою запись
      await request(app.getHttpServer())
        .post('/api/convert')
        .set('Cookie', saver.cookie)
        .field('targetFormat', 'json')
        .field('save', 'true')
        .attach('file', Buffer.from('a,b\r\n1,2\r\n'), 'data.csv')
        .expect(200);

      const list = await own(saver, { limit: '1' }).expect(200);
      const record = await history.findOneBy({ id: list.body.items[0].id });
      const fileId = record!.fileId!;

      expect(await storage.open(fileId)).not.toBeNull();

      // Состариваем запись, чтобы она попала под уборку
      await history.update(
        { id: record!.id },
        { createdAt: new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000) },
      );

      await retention.purge();

      expect(await history.findOneBy({ id: record!.id })).toBeNull();
      expect(await storage.open(fileId)).toBeNull();
    });
  });
});
