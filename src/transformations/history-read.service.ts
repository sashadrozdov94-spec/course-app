import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type SelectQueryBuilder } from 'typeorm';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { RbacService } from '../rbac/rbac.service.js';
import type { User } from '../users/entities/user.entity.js';
import { UsersService } from '../users/users.service.js';
import {
  type ListHistoryDto,
  type TransformationHistoryItem,
  type TransformationHistoryPage,
} from './dto/list-history.dto.js';
import { Transformation } from './entities/transformation.entity.js';
import { canReadHistoryOf } from './history-access.js';
import { TransformationStatus } from './transformation.js';

/**
 * Чтение истории трансформаций (п. 1 ТЗ).
 *
 * Пагинация курсорная, а не по номеру страницы: на OFFSET база отсчитывает
 * пропускаемые строки каждый раз заново, и десятая страница стоит дороже
 * первой. Плюс между запросами человек продолжает конвертировать — и
 * строки съезжают, повторяясь или пропадая. Курсор говорит «продолжи с
 * этого места», и ответ на одни и те же параметры стабилен (п. 1.6 ТЗ).
 *
 * Порядок один и не настраивается: новые сверху. Истории вопрос «что было
 * недавно» задают почти всегда, а каждый дополнительный порядок — это ещё
 * один индекс и ещё одна форма курсора.
 */
@Injectable()
export class HistoryReadService {
  private readonly logger = new Logger('TransformationHistory');

  constructor(
    @InjectRepository(Transformation)
    private readonly history: Repository<Transformation>,
    private readonly rbac: RbacService,
    private readonly users: UsersService,
  ) {}

  /** Своя история (п. 1.3.1 ТЗ). Прав не требует — это свои же записи. */
  async listOwn(
    actor: User,
    query: ListHistoryDto,
  ): Promise<TransformationHistoryPage> {
    const page = await this.page(actor.id, query);

    this.log(actor.id, null, query, 200, page.items.length);

    return page;
  }

  /**
   * История указанного пользователя (п. 1.3.2 ТЗ).
   *
   * Право проверяется здесь, а не наклейкой @RequirePermission на
   * контроллере: так отказ попадает в журнал вместе с тем, чью историю
   * пытались открыть, — ровно этого требует п. 1.5 ТЗ. Наклейка знает
   * только имя права.
   *
   * Себя через это окно смотреть можно и без права: запрет выглядел бы
   * произволом — эти же записи человеку отдаёт соседний адрес.
   */
  async listFor(
    actor: User,
    userId: string,
    query: ListHistoryDto,
  ): Promise<TransformationHistoryPage> {
    if (!(await canReadHistoryOf(this.rbac, actor, userId))) {
      this.log(actor.id, userId, query, 403, 0);
      throw new ForbiddenException('Нет прав на просмотр чужой истории');
    }

    // Проверка после права, а не до: иначе по разнице между 404 и 403
    // посторонний мог бы выяснять, какие номера пользователей существуют
    if (!(await this.users.findById(userId))) {
      this.log(actor.id, userId, query, 404, 0);
      throw new NotFoundException('Пользователь не найден');
    }

    const page = await this.page(userId, query);

    this.log(actor.id, userId, query, 200, page.items.length);

    return page;
  }

  /** Одна страница истории одного пользователя. */
  private async page(
    userId: string,
    query: ListHistoryDto,
  ): Promise<TransformationHistoryPage> {
    const builder = this.buildQuery(userId, query);

    // Просим на одну строку больше, чем нужно: если она пришла — значит
    // впереди есть ещё, и можно отдать курсор. Отдельный COUNT для этого
    // не нужен, а он на больших таблицах дорогой.
    const rows = await builder.take(query.limit + 1).getMany();
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items[items.length - 1];

    return {
      items: items.map(toItem),
      nextCursor:
        hasMore && last
          ? encodeCursor({ value: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  private buildQuery(
    userId: string,
    query: ListHistoryDto,
  ): SelectQueryBuilder<Transformation> {
    const builder = this.history
      .createQueryBuilder('t')
      // Явный список колонок: имя исходного файла в ответ не идёт, и
      // выбирать его незачем — см. комментарий к сущности
      .select([
        't.id',
        't.type',
        't.sourceFormat',
        't.targetFormat',
        't.status',
        't.statusCode',
        't.fileSize',
        't.durationMs',
        't.createdAt',
        // Ключ файла в ответ не идёт — только сам факт, что файл есть, и
        // до каких пор он будет. Без этого клиенту оставалось бы
        // предлагать скачивание наугад и ловить 404
        't.fileId',
        't.expiresAt',
      ])
      .where('t.userId = :userId', { userId });

    if (query.type) {
      builder.andWhere('t.type = :type', { type: query.type });
    }

    if (query.sourceFormat) {
      builder.andWhere('t.sourceFormat = :sourceFormat', {
        sourceFormat: query.sourceFormat,
      });
    }

    if (query.targetFormat) {
      builder.andWhere('t.targetFormat = :targetFormat', {
        targetFormat: query.targetFormat,
      });
    }

    if (query.status) {
      builder.andWhere('t.status = :status', { status: query.status });
    }

    // Границы периода включительные с обеих сторон: «с 1 по 31 января»
    // естественно читается как «включая 31-е»
    if (query.createdAtFrom) {
      builder.andWhere('t.createdAt >= :from', { from: query.createdAtFrom });
    }

    if (query.createdAtTo) {
      builder.andWhere('t.createdAt <= :to', { to: query.createdAtTo });
    }

    this.applyCursor(builder, query.cursor);

    // Вторым ключом всегда id: он уникален, поэтому порядок строк
    // определён однозначно даже при совпадающем времени. Без него две
    // конвертации в одну миллисекунду разъезжались бы между страницами.
    return builder.orderBy('t.createdAt', 'DESC').addOrderBy('t.id', 'DESC');
  }

  /**
   * «Продолжи с этого места».
   *
   * Сравниваем пару значений сразу: (время, id) меньше пары из курсора.
   * Postgres умеет сравнивать кортежи, и получается ровно тот же порядок,
   * что и в ORDER BY, — без этого строки с одинаковым временем попадали бы
   * на две страницы сразу.
   */
  private applyCursor(
    builder: SelectQueryBuilder<Transformation>,
    cursor: string | undefined,
  ): void {
    if (!cursor) {
      return;
    }

    const decoded = decodeCursor(cursor);

    if (!decoded) {
      throw new BadRequestException('Некорректный курсор');
    }

    builder.andWhere(
      '(t.createdAt, t.id) < (CAST(:cursorValue AS timestamptz), CAST(:cursorId AS uuid))',
      { cursorValue: decoded.value, cursorId: decoded.id },
    );
  }

  /**
   * Журнал п. 1.5: актор, чья история, параметры, результат, число строк.
   *
   * Значения фильтров писать можно: это форматы и статусы, персональных
   * данных в них нет. Номер пользователя, чью историю смотрят, — тоже:
   * без него запись «кто-то смотрел чужое» бесполезна.
   */
  private log(
    actorUserId: string,
    targetUserId: string | null,
    query: ListHistoryDto,
    statusCode: number,
    returned: number,
  ): void {
    const filters = [
      `limit=${query.limit}`,
      query.type ? `type=${query.type}` : null,
      query.sourceFormat ? `from=${query.sourceFormat}` : null,
      query.targetFormat ? `to=${query.targetFormat}` : null,
      query.status ? `status=${query.status}` : null,
      query.createdAtFrom ? 'since=есть' : null,
      query.createdAtTo ? 'until=есть' : null,
      query.cursor ? 'cursor=есть' : null,
    ]
      .filter(Boolean)
      .join(' ');

    this.logger.log(
      `actor=${actorUserId} ` +
        (targetUserId === null ? 'своя история' : `target=${targetUserId}`) +
        ` ${filters} → ${statusCode} (строк ${returned})`,
    );
  }
}

/**
 * Строка таблицы → строка ответа.
 *
 * errorCode — это код ответа, которым закончилась попытка: 400, 413, 415.
 * Отдельного словаря символьных кодов в приложении нет, а придумывать его
 * ради одного поля значило бы завести вторую систему обозначений рядом с
 * уже понятной. У успешных записей поля нет вовсе, а не «200»: п. 1.3.1 ТЗ
 * объявляет его только для отказов.
 */
function toItem(row: Transformation): TransformationHistoryItem {
  return {
    id: row.id,
    type: row.type,
    sourceFormat: row.sourceFormat,
    targetFormat: row.targetFormat,
    status: row.status,
    fileSize: row.fileSize,
    durationMs: row.durationMs,
    ...(row.status === TransformationStatus.Error
      ? { errorCode: String(row.statusCode) }
      : {}),
    createdAt: row.createdAt,
    // Сам ключ наружу не отдаётся никогда: скачивание идёт по номеру
    // записи, и право проверяется каждый раз заново
    saved: row.fileId !== null && !expired(row),
    expiresAt: row.fileId === null ? null : row.expiresAt,
  };
}

/** Истёк ли срок хранения файла. Записи без срока живут вечно. */
function expired(row: Transformation): boolean {
  return row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();
}
