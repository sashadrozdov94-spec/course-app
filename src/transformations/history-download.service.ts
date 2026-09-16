import {
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Readable } from 'node:stream';
import { Repository } from 'typeorm';
import { RbacService } from '../rbac/rbac.service.js';
import { FileStorage } from '../storage/file-storage.js';
import type { User } from '../users/entities/user.entity.js';
import { UsersService } from '../users/users.service.js';
import { Transformation } from './entities/transformation.entity.js';
import { canReadHistoryOf } from './history-access.js';

/** Файл, готовый к отдаче. */
export interface DownloadResult {
  stream: Readable;
  mime: string;
  filename: string;
  /** Длина, чтобы клиент видел прогресс. null — размер неизвестен. */
  size: number | null;
}

/**
 * Скачивание сохранённого результата (п. 1.3.2 и 1.3.3 ТЗ).
 *
 * Скачивание идёт по номеру записи истории, а не по ключу файла, и это
 * главное решение здесь. Ключ наружу не отдаётся никогда: ссылка на файл,
 * даже неугадываемая, — это доступ без проверки, который нельзя отозвать
 * и нельзя привязать к человеку. По номеру записи право проверяется
 * каждый раз заново, и отозванное право перестаёт работать сразу.
 *
 * Отсюда же защита от IDOR (п. 1.6 ТЗ): номер записи угадать нельзя (это
 * UUID), но даже угаданный он не поможет — владельца проверяют до того,
 * как дело дойдёт до хранилища.
 */
@Injectable()
export class HistoryDownloadService {
  private readonly logger = new Logger('TransformationDownload');

  constructor(
    @InjectRepository(Transformation)
    private readonly history: Repository<Transformation>,
    private readonly storage: FileStorage,
    private readonly rbac: RbacService,
    private readonly users: UsersService,
  ) {}

  /**
   * Свой файл (п. 1.3.2 ТЗ).
   *
   * Чужая запись — 403, а не 404: так написано в ТЗ, и здесь это
   * безопасно. В списке по пользователям мы, наоборот, прячем
   * существование аккаунта за 403, потому что номера там перебирают; тут
   * перебирать нечего — номер записи это UUID, и «угадал чужой номер»
   * означает, что он у человека уже был.
   */
  async downloadOwn(actor: User, itemId: string): Promise<DownloadResult> {
    const record = await this.history.findOneBy({ id: itemId });

    if (!record) {
      this.deny(actor.id, null, itemId, 404, 'записи нет');
      throw new NotFoundException('Запись истории не найдена');
    }

    if (record.userId !== actor.id) {
      this.deny(actor.id, record.userId, itemId, 403, 'чужая запись');
      throw new ForbiddenException('Это не ваша запись истории');
    }

    return this.fileOf(actor, record);
  }

  /**
   * Файл указанного пользователя (п. 1.3.3 ТЗ).
   *
   * Порядок проверок тот же, что и у списка: сначала право, потом
   * существование пользователя. Иначе по разнице между 404 и 403
   * посторонний перебирал бы номера аккаунтов.
   */
  async downloadFor(
    actor: User,
    userId: string,
    itemId: string,
  ): Promise<DownloadResult> {
    if (!(await canReadHistoryOf(this.rbac, actor, userId))) {
      this.deny(actor.id, userId, itemId, 403, 'нет права');
      throw new ForbiddenException('Нет прав на чужую историю');
    }

    if (!(await this.users.findById(userId))) {
      this.deny(actor.id, userId, itemId, 404, 'пользователя нет');
      throw new NotFoundException('Пользователь не найден');
    }

    // Ищем сразу с проверкой владельца: запись есть, но у другого
    // человека — для этого окна то же самое, что «нет записи». Отвечать
    // иначе значило бы рассказывать, кому какая запись принадлежит
    const record = await this.history.findOneBy({ id: itemId, userId });

    if (!record) {
      this.deny(actor.id, userId, itemId, 404, 'записи нет у пользователя');
      throw new NotFoundException('Запись истории не найдена');
    }

    return this.fileOf(actor, record);
  }

  /**
   * Достать файл записи, проверив, что он вообще есть и ещё жив.
   *
   * Три разных «нет файла», и они означают разное:
   *
   *   сохранения не просили — 404, файла никогда и не было;
   *   срок истёк            — 410, файл был и его больше нет (ТЗ
   *                           разрешает и 404, но 410 честнее: по нему
   *                           видно, что ссылка не сломана, а устарела);
   *   в хранилище пусто     — 404, запись и хранилище разошлись.
   */
  private async fileOf(
    actor: User,
    record: Transformation,
  ): Promise<DownloadResult> {
    const startedAt = Date.now();

    if (!record.fileId) {
      this.deny(actor.id, record.userId, record.id, 404, 'файл не сохраняли');
      throw new NotFoundException(
        'У этой трансформации нет сохранённого файла: её выполняли без save',
      );
    }

    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
      this.deny(actor.id, record.userId, record.id, 410, 'срок истёк');
      throw new GoneException('Срок хранения файла истёк');
    }

    const stream = await this.storage.open(record.fileId);

    if (!stream) {
      // Запись обещает файл, а хранилище его не отдаёт. Для клиента это
      // просто «нет файла», а вот нам стоит знать: так выглядит
      // рассинхронизация базы и диска
      this.logger.error(
        `Файл ${record.fileId} записи ${record.id} отсутствует в хранилище`,
      );
      this.deny(actor.id, record.userId, record.id, 404, 'нет в хранилище');
      throw new NotFoundException('Файл больше недоступен');
    }

    this.logger.log(
      `actor=${actor.id} download ${record.id} ${record.fileId} ` +
        `${record.resultSize ?? '?'} байт → 200 за ${Date.now() - startedAt} мс`,
    );

    return {
      stream,
      mime: record.resultMime ?? 'application/octet-stream',
      filename: record.resultName ?? `converted.${record.targetFormat}`,
      size: record.resultSize,
    };
  }

  /**
   * Журнал отказа (п. 1.5 ТЗ): кто, чей файл, какая запись, чем кончилось.
   *
   * Содержимого файла здесь нет и быть не может — только номера.
   */
  private deny(
    actorUserId: string,
    ownerUserId: string | null,
    itemId: string,
    statusCode: number,
    reason: string,
  ): void {
    this.logger.warn(
      `actor=${actorUserId} download ${itemId} ` +
        (ownerUserId === null ? '' : `owner=${ownerUserId} `) +
        `→ ${statusCode} (${reason})`,
    );
  }
}

/**
 * Файл из хранилища → ответ.
 *
 * StreamableFile, а не буфер: тело уходит клиенту по мере чтения с диска,
 * и файл на сотню мегабайт не оседает в памяти целиком — этого и требует
 * п. 1.6 ТЗ о потоковой передаче.
 *
 * Живёт рядом с сервисом, а не в контроллере: оба окна, своё и
 * административное, собирают ответ одинаково, и класть общий код в один
 * из контроллеров значило бы сделать его старшим над вторым.
 */
export function toStreamable(file: DownloadResult): StreamableFile {
  return new StreamableFile(file.stream, {
    type: file.mime,
    disposition: `attachment; filename="${file.filename}"`,
    ...(file.size === null ? {} : { length: file.size }),
  });
}
