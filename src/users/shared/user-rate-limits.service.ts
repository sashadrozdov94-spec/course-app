import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountRateLimiter } from '../../common/account-rate-limiter.js';
import type { Env } from '../../config/env.schema.js';

/**
 * Все персональные лимиты на операции с пользователями — в одном месте
 * (п. 1.4 всех трёх ТЗ).
 *
 * Раньше их было два класса: ProfileReadLimiter и ProfileWriteLimiter, причём
 * во втором лежал ещё и счётчик удалений — и сервис удаления зависел от
 * «лимитера записи профиля». Теперь один сервис с четырьмя счётчиками,
 * и каждый вызывающий берёт свой.
 *
 * Числа разные, потому что действия разной цены:
 *
 *   чтение чужих профилей — так выкачивают базу пользователей;
 *   изменение профиля     — обычная запись;
 *   смена почты, удаление — письмо на указанный адрес, то есть
 *                           постороннему человеку. Отсюда лимит на порядок
 *                           строже и окно длиннее.
 *
 * Это дополнение к @RateLimit на эндпоинтах, а не замена: тот считает по
 * адресу клиента, эти — по аккаунту. Смена IP от них не спасает.
 */
@Injectable()
export class UserRateLimits {
  private readonly foreignRead: AccountRateLimiter;
  private readonly profileWrite: AccountRateLimiter;
  private readonly emailChange: AccountRateLimiter;
  private readonly deletion: AccountRateLimiter;
  private readonly userList: AccountRateLimiter;

  constructor(config: ConfigService<Env, true>) {
    this.foreignRead = new AccountRateLimiter(
      config.get('PROFILE_FOREIGN_READ_LIMIT', { infer: true }),
      config.get('PROFILE_FOREIGN_READ_WINDOW_SECONDS', { infer: true }),
      (retryAfter) =>
        `Слишком много просмотров чужих профилей. Повторите через ${retryAfter} секунд`,
    );

    this.profileWrite = new AccountRateLimiter(
      config.get('PROFILE_WRITE_LIMIT', { infer: true }),
      config.get('PROFILE_WRITE_WINDOW_SECONDS', { infer: true }),
      (retryAfter) =>
        `Слишком много изменений профиля. Повторите через ${retryAfter} секунд`,
    );

    this.emailChange = new AccountRateLimiter(
      config.get('EMAIL_CHANGE_LIMIT', { infer: true }),
      config.get('EMAIL_CHANGE_WINDOW_SECONDS', { infer: true }),
      (retryAfter) =>
        `Слишком много запросов на смену почты. Повторите через ${retryAfter} секунд`,
    );

    this.deletion = new AccountRateLimiter(
      config.get('DELETION_LIMIT', { infer: true }),
      config.get('DELETION_WINDOW_SECONDS', { infer: true }),
      (retryAfter) =>
        `Слишком много запросов на удаление. Повторите через ${retryAfter} секунд`,
    );

    this.userList = new AccountRateLimiter(
      config.get('USER_LIST_LIMIT', { infer: true }),
      config.get('USER_LIST_WINDOW_SECONDS', { infer: true }),
      (retryAfter) =>
        `Слишком много запросов списка. Повторите через ${retryAfter} секунд`,
    );
  }

  /** Запрос списка пользователей: выборка с фильтрами дороже чтения одной строки. */
  hitUserList(actorUserId: string): void {
    this.userList.hit(actorUserId);
  }

  /**
   * Просмотр ЧУЖОГО профиля. Свой под этот счётчик не попадает: человек
   * волен открывать себя сколько угодно, общий лимит окна его придержит.
   */
  hitForeignRead(viewerUserId: string): void {
    this.foreignRead.hit(viewerUserId);
  }

  /** Изменение профиля (PATCH). */
  hitProfileWrite(actorUserId: string): void {
    this.profileWrite.hit(actorUserId);
  }

  /** Запрос смены почты — то есть отправка письма. */
  hitEmailChange(actorUserId: string): void {
    this.emailChange.hit(actorUserId);
  }

  /** Запрос удаления аккаунта — тоже письмо. */
  hitDeletion(actorUserId: string): void {
    this.deletion.hit(actorUserId);
  }
}
