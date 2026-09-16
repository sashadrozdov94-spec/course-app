import { BadRequestException, StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import { ConvertController } from './convert/convert.controller.js';
import type { ConvertService } from './convert/convert.service.js';
import { ImagesController } from './images/images.controller.js';
import type { ImagesService } from './images/images.service.js';
import { RbacConfigController } from './rbac/admin/config.controller.js';
import { RbacGrantsController } from './rbac/admin/grants.controller.js';
import { RbacPermissionsController } from './rbac/admin/permissions.controller.js';
import { RbacRolesController } from './rbac/admin/roles.controller.js';
import type { GrantsService } from './rbac/grants.service.js';
import type { PermissionsService } from './rbac/permissions.service.js';
import type { RbacConfigService } from './rbac/rbac-config.service.js';
import type { RolesService } from './rbac/roles.service.js';
import { UserHistoryController } from './transformations/admin/user-history.controller.js';
import type { HistoryDownloadService } from './transformations/history-download.service.js';
import type { HistoryReadService } from './transformations/history-read.service.js';
import { HistoryController } from './transformations/history.controller.js';
import { UserListController } from './users/admin-list/user-list.controller.js';
import type { UserListService } from './users/admin-list/user-list.service.js';
import { DeletionController } from './users/deletion/deletion.controller.js';
import type { DeletionService } from './users/deletion/deletion.service.js';
import { EmailChangeController } from './users/email-change/email-change.controller.js';
import type { EmailChangeService } from './users/email-change/email-change.service.js';
import type { User } from './users/entities/user.entity.js';
import type { ProfileReadService } from './users/profile/profile-read.service.js';
import type { ProfileWriteService } from './users/profile/profile-write.service.js';
import { ProfileController } from './users/profile/profile.controller.js';

/**
 * Контроллеры приложения.
 *
 * Проверяем не бизнес-правила — они живут в сервисах и проверены там, — а
 * проводку: что контроллер зовёт нужный метод, передаёт ему то, что
 * пришло из запроса (и берёт хозяина из токена, а не из строки запроса), и
 * заворачивает ответ так, как обещал контракт.
 *
 * Ошибка здесь тихая и неприятная: всё написано правильно, но вызывается
 * не то или не с тем — и e2e ловит её только если такой запрос кто-то
 * догадался проверить.
 */

const ME = { id: 'user-me' } as User;
const UUID = '11111111-2222-4333-8444-555555555555';

/** Запоминает вызовы сервиса: что позвали и с чем. */
function spy<T>(result: T) {
  const calls: unknown[][] = [];

  return {
    calls,
    fn: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(result);
    },
  };
}

describe('Конвертация файлов', () => {
  it('передаёт файл, формат и флаг сохранения', async () => {
    const convert = spy({
      body: Buffer.from('[]'),
      mime: 'application/json',
      filename: 'converted.json',
    });
    const controller = new ConvertController({
      convert: convert.fn,
    } as unknown as ConvertService);
    const file = { buffer: Buffer.from('a'), size: 1 };

    const answer = await controller.convert(
      file,
      { targetFormat: 'json', save: true } as never,
      ME,
    );

    // Хозяин берётся из токена, а не из формы
    expect(convert.calls[0]).toEqual([ME.id, file, 'json', true]);
    expect(answer).toBeInstanceOf(StreamableFile);
    expect(answer.options.disposition).toContain('converted.json');
  });

  it('без файла — 400, до похода в сервис', async () => {
    const convert = spy(null);
    const controller = new ConvertController({
      convert: convert.fn,
    } as unknown as ConvertService);

    await expect(
      controller.convert(undefined, { targetFormat: 'json' } as never, ME),
    ).rejects.toThrow(BadRequestException);
    expect(convert.calls).toHaveLength(0);
  });

  it('список направлений отдаёт то, что собрал сервис', () => {
    const directions = [{ source: 'csv', target: ['json'] }];
    const controller = new ConvertController({
      supportedFormats: () => directions,
    } as unknown as ConvertService);

    expect(controller.formats()).toBe(directions);
  });
});

describe('Конвертация изображений', () => {
  it('передаёт параметры и флаг сохранения', async () => {
    const convert = spy({
      body: Buffer.from('x'),
      mime: 'image/png',
      filename: 'converted.png',
    });
    const controller = new ImagesController({
      convert: convert.fn,
    } as unknown as ImagesService);
    const file = { buffer: Buffer.from('x'), size: 1 };
    const options = { width: 100 };

    const answer = await controller.convert(
      file,
      { targetFormat: 'png', options, save: false } as never,
      ME,
    );

    expect(convert.calls[0]).toEqual([ME.id, file, 'png', options, false]);
    expect(answer.options.type).toBe('image/png');
  });

  it('без файла — 400', async () => {
    const controller = new ImagesController({} as unknown as ImagesService);

    await expect(
      controller.convert(undefined, { targetFormat: 'png' } as never, ME),
    ).rejects.toThrow(BadRequestException);
  });

  it('отдаёт список направлений', () => {
    const directions = [{ source: 'svg', target: ['png'] }];
    const controller = new ImagesController({
      supportedFormats: () => directions,
    } as unknown as ImagesService);

    expect(controller.formats()).toBe(directions);
  });
});

describe('История трансформаций', () => {
  const page = { items: [], nextCursor: null };

  it('свой список спрашивает по владельцу из токена', async () => {
    const list = spy(page);
    const controller = new HistoryController(
      { listOwn: list.fn } as unknown as HistoryReadService,
      {} as unknown as HistoryDownloadService,
    );
    const query = { limit: 20 } as never;

    expect(await controller.list(query, ME)).toBe(page);
    expect(list.calls[0]).toEqual([ME, query]);
  });

  it('скачивание своего файла заворачивается в потоковый ответ', async () => {
    const download = spy({
      stream: Readable.from(['x']),
      mime: 'application/json',
      filename: 'converted.json',
      size: 1,
    });
    const controller = new HistoryController(
      {} as unknown as HistoryReadService,
      { downloadOwn: download.fn } as unknown as HistoryDownloadService,
    );

    const answer = await controller.download({ itemId: UUID }, ME);

    expect(download.calls[0]).toEqual([ME, UUID]);
    expect(answer.options.disposition).toContain('converted.json');
  });

  it('административный список спрашивает по номеру из адреса', async () => {
    const list = spy(page);
    const controller = new UserHistoryController(
      { listFor: list.fn } as unknown as HistoryReadService,
      {} as unknown as HistoryDownloadService,
    );
    const query = { limit: 20 } as never;

    await controller.list({ userId: 'owner-1' }, query, ME);

    expect(list.calls[0]).toEqual([ME, 'owner-1', query]);
  });

  it('административное скачивание передаёт и владельца, и запись', async () => {
    const download = spy({
      stream: Readable.from(['x']),
      mime: 'image/png',
      filename: 'converted.png',
      size: null,
    });
    const controller = new UserHistoryController(
      {} as unknown as HistoryReadService,
      { downloadFor: download.fn } as unknown as HistoryDownloadService,
    );

    const answer = await controller.download(
      { userId: 'owner-1' },
      { itemId: UUID },
      ME,
    );

    expect(download.calls[0]).toEqual([ME, 'owner-1', UUID]);
    // Размер неизвестен — длину не выдумываем
    expect(answer.options.length).toBeUndefined();
  });
});

describe('Раздел администратора: RBAC', () => {
  it('роли: список, создание, правка и удаление', async () => {
    const findAll = spy([]);
    const create = spy({ id: 'r1' });
    const update = spy({ id: 'r1' });
    const remove = spy(undefined);

    const controller = new RbacRolesController({
      findAll: findAll.fn,
      create: create.fn,
      update: update.fn,
      remove: remove.fn,
    } as unknown as RolesService);

    await controller.findAll();
    await controller.create({ name: 'support' }, ME);
    await controller.update({ roleId: 'r1' }, { name: 'helpdesk' }, ME);

    const deleted = await controller.remove(
      { roleId: 'r1' },
      { force: true },
      ME,
    );

    expect(create.calls[0]).toEqual([{ name: 'support' }, ME.id]);
    expect(update.calls[0]).toEqual(['r1', { name: 'helpdesk' }, ME.id]);
    expect(remove.calls[0]).toEqual(['r1', true, ME.id]);
    // Удаление отвечает подтверждением, а не пустым телом
    expect(deleted).toEqual({ id: 'r1', deleted: true });
  });

  it('разрешения: те же четыре действия', async () => {
    const findAll = spy([]);
    const create = spy({ id: 'p1' });
    const update = spy({ id: 'p1' });
    const remove = spy(undefined);

    const controller = new RbacPermissionsController({
      findAll: findAll.fn,
      create: create.fn,
      update: update.fn,
      remove: remove.fn,
    } as unknown as PermissionsService);

    await controller.findAll();
    await controller.create({ name: 'users', actions: ['read'] }, ME);
    await controller.update({ permissionId: 'p1' }, { actions: ['list'] }, ME);

    expect(await controller.remove({ permissionId: 'p1' }, ME)).toEqual({
      id: 'p1',
      deleted: true,
    });
    expect(remove.calls[0]).toEqual(['p1', ME.id]);
  });

  it('назначения: те же четыре действия', async () => {
    const findAll = spy([]);
    const create = spy({ id: 'g1' });
    const update = spy({ id: 'g1' });
    const remove = spy(undefined);

    const controller = new RbacGrantsController({
      findAll: findAll.fn,
      create: create.fn,
      update: update.fn,
      remove: remove.fn,
    } as unknown as GrantsService);

    await controller.findAll();
    await controller.create({ roleId: 'r1', permissionId: 'p1' }, ME);
    await controller.update({ grantId: 'g1' }, { actions: [] }, ME);

    expect(await controller.remove({ grantId: 'g1' }, ME)).toEqual({
      id: 'g1',
      deleted: true,
    });
  });

  describe('Снимок конфигурации', () => {
    const loadedAt = new Date('2026-01-01T00:00:00.000Z');

    const config = {
      loadedAt,
      permissions: new Map([
        ['users', { id: 'p1', actions: new Set(['read']) }],
      ]),
      grants: new Map([['r1', new Map([['users', new Set(['read'])]])]]),
      roleNames: new Map([['r1', 'support']]),
    };

    it('разворачивает множества в списки', async () => {
      const controller = new RbacConfigController({
        getConfig: () => Promise.resolve(config),
      } as unknown as RbacConfigService);

      const snapshot = await controller.snapshot();

      expect(snapshot.loadedAt).toBe(loadedAt);
      expect(snapshot.permissions).toEqual([
        { name: 'users', actions: ['read'] },
      ]);
      expect(snapshot.roles).toEqual([
        {
          id: 'r1',
          name: 'support',
          grants: [
            { permission: 'users', actions: ['read'], allActions: false },
          ],
        },
      ]);
    });

    it('показывает, где выданы все действия разрешения', async () => {
      const controller = new RbacConfigController({
        getConfig: () =>
          Promise.resolve({
            ...config,
            grants: new Map([['r1', new Map([['users', null]])]]),
          }),
      } as unknown as RbacConfigService);

      const snapshot = await controller.snapshot();

      expect(snapshot.roles[0]!.grants[0]).toEqual({
        permission: 'users',
        actions: [],
        allActions: true,
      });
    });

    it('роль без назначений показывается с пустым списком', async () => {
      const controller = new RbacConfigController({
        getConfig: () => Promise.resolve({ ...config, grants: new Map() }),
      } as unknown as RbacConfigService);

      expect((await controller.snapshot()).roles[0]!.grants).toEqual([]);
    });

    it('перечитывание отвечает временем загрузки', async () => {
      const reload = spy({ loadedAt });
      const controller = new RbacConfigController({
        reload: reload.fn,
      } as unknown as RbacConfigService);

      expect(await controller.reload(ME)).toEqual({ loadedAt });
      expect(reload.calls[0]).toEqual([ME.id]);
    });
  });
});

describe('Раздел администратора: пользователи', () => {
  it('список передаёт и параметры, и того, кто спрашивает', async () => {
    const list = spy({ items: [], nextCursor: null });
    const controller = new UserListController({
      list: list.fn,
    } as unknown as UserListService);
    const query = { limit: 20 } as never;

    await controller.list(query, ME);

    // Сервис получает сначала того, кто спрашивает: право проверяется
    // до фильтров
    expect(list.calls[0]).toEqual([ME, query]);
  });
});

describe('Профиль', () => {
  it('чтение спрашивает по номеру из адреса', async () => {
    const view = spy({ id: 'u1' });
    const controller = new ProfileController(
      { view: view.fn } as unknown as ProfileReadService,
      {} as unknown as ProfileWriteService,
    );

    await controller.findOne({ userId: 'u1' }, ME);

    expect(view.calls[0]).toEqual([ME, 'u1']);
  });

  it('правка передаёт присланные поля', async () => {
    const update = spy({ updated: ['photo'] });
    const controller = new ProfileController(
      {} as unknown as ProfileReadService,
      { update: update.fn } as unknown as ProfileWriteService,
    );
    const patch = { photo: 'new.png' };

    await controller.update({ userId: 'u1' }, patch, ME);

    expect(update.calls[0]).toEqual([ME, 'u1', patch]);
  });
});

describe('Смена почты и удаление аккаунта', () => {
  it('запрос на удаление передаёт причину', async () => {
    const request = spy({ requested: true });
    const controller = new DeletionController({
      request: request.fn,
    } as unknown as DeletionService);

    await controller.request({ userId: 'u1' }, { reason: 'надоело' }, ME);

    expect(request.calls[0]).toEqual([ME, 'u1', 'надоело']);
  });

  it('подтверждение удаления кодом и ссылкой', async () => {
    const byCode = spy({ deleted: true });
    const byLink = spy({ deleted: true });
    const controller = new DeletionController({
      confirmByCode: byCode.fn,
      confirmByLink: byLink.fn,
    } as unknown as DeletionService);
    const dto = { challengeId: UUID, code: '1234' };

    await controller.confirmByCode({ userId: 'u1' }, dto, ME);
    await controller.confirmByLink('токен');

    expect(byCode.calls[0]).toEqual([ME, 'u1', dto]);
    expect(byLink.calls[0]).toEqual(['токен']);
  });

  it('без токена в ссылке передаётся пустая строка, а не undefined', async () => {
    const byLink = spy({ deleted: true });
    const controller = new DeletionController({
      confirmByLink: byLink.fn,
    } as unknown as DeletionService);

    await controller.confirmByLink(undefined as unknown as string);

    expect(byLink.calls[0]).toEqual(['']);
  });

  it('смена почты: запрос и оба подтверждения', async () => {
    const request = spy({ requested: true });
    const byCode = spy({ changed: true });
    const byLink = spy({ changed: true });
    const controller = new EmailChangeController({
      request: request.fn,
      confirmByCode: byCode.fn,
      confirmByLink: byLink.fn,
    } as unknown as EmailChangeService);
    const dto = { challengeId: UUID, code: '1234' };

    await controller.request({ userId: 'u1' }, { newEmail: 'a@b.com' }, ME);
    await controller.confirmByCode({ userId: 'u1' }, dto, ME);
    await controller.confirmByLink('токен');

    expect(request.calls[0]).toEqual([ME, 'u1', 'a@b.com']);
    expect(byCode.calls[0]).toEqual([ME, 'u1', dto]);
    expect(byLink.calls[0]).toEqual(['токен']);
  });
});
