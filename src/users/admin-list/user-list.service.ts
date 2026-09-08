import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type SelectQueryBuilder } from 'typeorm';
import { RbacService } from '../../rbac/rbac.service.js';
import { User } from '../entities/user.entity.js';
import { UserRateLimits } from '../shared/user-rate-limits.service.js';
import { USERS_ACTIONS, USERS_PERMISSION } from '../shared/users-permission.js';
import {
  type Cursor,
  decodeCursor,
  encodeCursor,
  type ListUsersDto,
  maskEmail,
  SORT_COLUMNS,
  type SortKey,
  type UserListItem,
  type UserListPage,
} from './dto/list-users.dto.js';

/**
 * Замена NULL при сортировке по последнему входу.
 *
 * Без неё «ни разу не входил» выпадает из порядка: NULL не больше и не
 * меньше ничего, а курсорной пагинации нужен полный порядок, иначе строки
 * будут теряться между страницами. Такие пользователи оказываются в самом
 * начале истории — что и означает «никогда».
 */
const NEVER_LOGGED_IN = '1970-01-01T00:00:00Z';

/**
 * Список пользователей для администратора (п. 1 ТЗ).
 *
 * Пагинация курсорная, а не по номеру страницы: на OFFSET база отсчитывает
 * пропускаемые строки каждый раз заново, и десятая страница стоит дороже
 * первой. Плюс между запросами кто-то регистрируется — и строки съезжают,
 * повторяясь или пропадая. Курсор говорит «продолжи с этого места», и
 * ответ на одни и те же параметры стабилен (п. 1.6 ТЗ).
 */
@Injectable()
export class UserListService {
  private readonly logger = new Logger('UserList');

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly rbac: RbacService,
    private readonly limits: UserRateLimits,
  ) {}

  async list(actor: User, query: ListUsersDto): Promise<UserListPage> {
    this.limits.hitUserList(actor.id);

    const actions = await this.rbac.allowedActions(actor, USERS_PERMISSION);

    if (!actions.has(USERS_ACTIONS.List)) {
      this.log(actor.id, query, 403, 0);
      throw new ForbiddenException('Нет прав на просмотр списка пользователей');
    }

    // Полный адрес открывает то же право, что и в карточке одного
    // пользователя. Без него — маска: список не должен быть способом
    // выгрузить все рабочие адреса разом.
    const showEmail = actions.has(USERS_ACTIONS.ReadEmail);

    const builder = this.buildQuery(query);

    // Просим на одну строку больше, чем нужно: если она пришла — значит
    // впереди есть ещё, и можно отдать курсор. Отдельный COUNT для этого
    // не нужен, а он на больших таблицах дорогой.
    const rows = await builder.take(query.limit + 1).getMany();
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    this.log(actor.id, query, 200, page.length);

    return {
      items: page.map((user) => this.toItem(user, showEmail)),
      nextCursor: hasMore
        ? this.cursorFor(page[page.length - 1], query.sort)
        : null,
    };
  }

  private buildQuery(query: ListUsersDto): SelectQueryBuilder<User> {
    const builder = this.users
      .createQueryBuilder('user')
      // Явный список колонок, а не выборка целиком: п. 1.4 ТЗ запрещает
      // отдавать чувствительные поля. passwordHash и так помечен
      // select: false, но полагаться на одну защиту не стоит.
      .select([
        'user.id',
        'user.email',
        'user.avatarUrl',
        'user.status',
        'user.createdAt',
        'user.lastLoginAt',
      ]);

    if (query.status) {
      builder.andWhere('user.status = :status', { status: query.status });
    }

    this.applySearch(builder, query.q);

    const expression = this.sortExpression(query.sort);
    const direction = query.order === 'asc' ? 'ASC' : 'DESC';

    this.applyCursor(builder, query, expression);

    // Вторым ключом всегда id: он уникален, поэтому порядок строк
    // определён однозначно даже при совпадающих значениях первого поля.
    builder.orderBy(expression, direction).addOrderBy('user.id', direction);

    return builder;
  }

  /**
   * Поиск по ТЗ — «email/имя/id», но искать можно только по тому, что у
   * нас есть: по номеру и по адресу. Имени в профиле пока нет.
   *
   * По адресу — совпадение с НАЧАЛОМ строки, а не с любым куском.
   * Поиск подстроки (`%текст%`) индекс использовать не может и на большой
   * таблице читает её целиком — ровно то, что п. 1.4 ТЗ просит не делать.
   */
  private applySearch(
    builder: SelectQueryBuilder<User>,
    q: string | undefined,
  ): void {
    if (!q) {
      return;
    }

    const looksLikeId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);

    if (looksLikeId) {
      builder.andWhere('user.id = :id', { id: q });
      return;
    }

    builder.andWhere('user.email ILIKE :prefix', {
      prefix: `${q.toLowerCase()}%`,
    });
  }

  /** Выражение, по которому идёт сортировка и сравнение курсора. */
  private sortExpression(sort: SortKey): string {
    if (sort === 'last_login') {
      return `COALESCE(user.lastLoginAt, '${NEVER_LOGGED_IN}')`;
    }

    return `user.${SORT_COLUMNS[sort]}`;
  }

  /**
   * «Продолжи с этого места».
   *
   * Сравниваем пару значений сразу: (поле, id) больше или меньше пары из
   * курсора. Postgres умеет сравнивать кортежи, и получается ровно тот же
   * порядок, что и в ORDER BY, — без этого строки с одинаковым значением
   * поля попадали бы на две страницы сразу.
   */
  private applyCursor(
    builder: SelectQueryBuilder<User>,
    query: ListUsersDto,
    expression: string,
  ): void {
    if (!query.cursor) {
      return;
    }

    const cursor = decodeCursor(query.cursor);

    if (!cursor) {
      throw new BadRequestException('Некорректный курсор');
    }

    const operator = query.order === 'asc' ? '>' : '<';
    const cast = query.sort === 'email' ? 'text' : 'timestamptz';

    builder.andWhere(
      `(${expression}, user.id) ${operator} (CAST(:cursorValue AS ${cast}), CAST(:cursorId AS uuid))`,
      { cursorValue: cursor.value, cursorId: cursor.id },
    );
  }

  private cursorFor(user: User, sort: SortKey): string {
    const cursor: Cursor = { value: this.sortValue(user, sort), id: user.id };
    return encodeCursor(cursor);
  }

  private sortValue(user: User, sort: SortKey): string {
    if (sort === 'email') {
      return user.email;
    }

    if (sort === 'last_login') {
      return (user.lastLoginAt ?? new Date(NEVER_LOGGED_IN)).toISOString();
    }

    return user.createdAt.toISOString();
  }

  private toItem(user: User, showEmail: boolean): UserListItem {
    return {
      id: user.id,
      email: showEmail ? user.email : maskEmail(user.email),
      // В базе колонка avatarUrl, в контракте из ТЗ — photo
      photo: user.avatarUrl,
      status: user.status,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };
  }

  /**
   * Журнал п. 1.5: актор, параметры, результат, число строк.
   *
   * Строку поиска в лог НЕ пишем — в неё вводят адрес почты, то есть
   * персональные данные. Пишем только сам факт поиска.
   */
  private log(
    actorUserId: string,
    query: ListUsersDto,
    statusCode: number,
    returned: number,
  ): void {
    const filters = [
      `sort=${query.sort}:${query.order}`,
      `limit=${query.limit}`,
      query.status ? `status=${query.status}` : null,
      query.q ? 'q=есть' : null,
      query.cursor ? 'cursor=есть' : null,
    ]
      .filter(Boolean)
      .join(' ');

    this.logger.log(
      `actor=${actorUserId} ${filters} → ${statusCode} (строк ${returned})`,
    );
  }
}
