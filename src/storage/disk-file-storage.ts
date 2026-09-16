import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { Env } from '../config/env.schema.js';
import { FileStorage } from './file-storage.js';

/**
 * Подпапка внутри UPLOAD_DIR, где лежат результаты трансформаций.
 *
 * Отдельно от аватаров: у них разный срок жизни и разные хозяева. Аватар
 * живёт, пока жив аккаунт; результат — пока не истёк срок хранения
 * истории, и его удаляет фоновая уборка. Свалить их в одну кучу значило
 * бы однажды подчистить лишнее.
 */
const SUBDIR = 'transformations';

/**
 * Сколько первых знаков имени уходит в название вложенной папки.
 *
 * Два знака дают 256 папок. Это не украшательство: каталог с сотней тысяч
 * файлов замедляет и файловую систему, и любую попытку заглянуть в него
 * руками, а раскладка по первым знакам разводит их ровным слоем, потому
 * что имена случайны.
 */
const SHARD_LENGTH = 2;

/**
 * Разрешённый вид ключа: «xx/имя» или «xx/имя.расширение».
 *
 * Ключи выдаём мы сами и храним в своей же базе, так что проверка тут не
 * от клиента, а от испорченной строки: ключ приходит из колонки, а в
 * колонку когда-нибудь попадёт что-нибудь не то — руками, миграцией,
 * восстановлением из бэкапа. Собрать путь из непроверенной строки значит
 * дать прочитать или удалить любой файл на диске, и «но туда же пишем
 * только мы» — слабое утешение.
 */
const KEY = /^[0-9a-f]{2}\/[0-9a-f-]{36}(?:\.[a-z0-9]{1,8})?$/;

/**
 * Хранилище на диске.
 *
 * Файлы лежат в UPLOAD_DIR — там же, где остальные загруженные файлы
 * приложения, — во вложенной папке transformations, разложенные по первым
 * знакам имени.
 *
 * Запись атомарна: сначала во временный файл, потом переименование.
 * Переименование в пределах одной файловой системы — одно действие, и
 * читатель видит либо старое состояние, либо новое. Без этого оборванная
 * на середине запись оставила бы обрезанный файл, который выглядит целым:
 * размер в базе один, на диске другой, и понять это можно только скачав.
 */
@Injectable()
export class DiskFileStorage extends FileStorage {
  private readonly logger = new Logger('DiskStorage');
  private readonly root: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.root = resolve(config.get('UPLOAD_DIR', { infer: true }), SUBDIR);
  }

  async put(body: Buffer, extension: string): Promise<string> {
    const name = randomUUID();
    const suffix = safeExtension(extension);
    const key = `${name.slice(0, SHARD_LENGTH)}/${name}${suffix}`;
    const path = this.pathFor(key);

    if (!path) {
      // Ключ мы только что собрали сами — сюда можно попасть, только
      // если разошлись правило KEY и способ сборки имени
      throw new Error(`Собран некорректный ключ файла: ${key}`);
    }

    // Временное имя рядом с целевым: переименование через границу
    // файловых систем перестаёт быть атомарным, а /tmp вполне может
    // оказаться отдельным разделом
    const temporary = `${path}.${process.pid}.tmp`;

    await mkdir(dirname(path), { recursive: true });

    try {
      await writeFile(temporary, body);
      await rename(temporary, path);
    } catch (error) {
      // Прибираем за собой: иначе неудачная запись оставит мусор, который
      // никто уже не найдёт — в базе про него ничего нет
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }

    return key;
  }

  async open(key: string): Promise<Readable | null> {
    const path = this.pathFor(key);

    if (!path) {
      return null;
    }

    return new Promise<Readable | null>((resolveStream) => {
      const stream = createReadStream(path);

      // Ошибку открытия ловим здесь, а не отдаём наружу сломанным
      // потоком: вызывающему нужно знать «файла нет» до того, как он
      // начнёт составлять ответ, иначе заголовки уже уйдут клиенту
      stream.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          this.logger.error(`Не удалось открыть ${key}: ${error.message}`);
        }

        stream.destroy();
        resolveStream(null);
      });

      stream.once('open', () => resolveStream(stream));
    });
  }

  async remove(key: string): Promise<boolean> {
    const path = this.pathFor(key);

    if (!path) {
      return false;
    }

    try {
      await unlink(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Файла уже нет — значит, работа сделана. Уборка обязана
        // переживать повторный заход
        return false;
      }

      throw error;
    }
  }

  /**
   * Ключ → путь на диске. Пустая строка, если ключ не тот.
   *
   * Проверяем и вид ключа, и результат сборки пути: даже с правильным на
   * вид ключом стоит убедиться, что получившийся путь остался внутри
   * нашей папки. Две проверки вместо одной — потому что цена ошибки здесь
   * не «не нашли файл», а «прочитали чужой».
   */
  private pathFor(key: string): string {
    if (!KEY.test(key)) {
      this.logger.warn(`Ключ файла не того вида: ${key}`);
      return '';
    }

    const path = resolve(this.root, key);

    if (path !== this.root && !path.startsWith(this.root + sep)) {
      this.logger.warn(`Путь файла вышел за пределы хранилища: ${key}`);
      return '';
    }

    return path;
  }
}

/**
 * Расширение для имени файла.
 *
 * Только буквы и цифры: расширение приходит из целевого формата, но точка
 * в имени — это то место, где обычно и начинаются неприятности с путями.
 * Ничего не подошло — обойдёмся без расширения, на поиск оно не влияет.
 */
function safeExtension(extension: string): string {
  const cleaned = extension.toLowerCase().replace(/[^a-z0-9]/g, '');

  return cleaned.length > 0 && cleaned.length <= 8 ? `.${cleaned}` : '';
}
