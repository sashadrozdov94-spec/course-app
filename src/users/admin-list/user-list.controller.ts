import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiZodQuery } from '../../common/openapi/zod-openapi.js';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { User } from '../entities/user.entity.js';
import {
  type ListUsersDto,
  listUsersSchema,
  type UserListPage,
} from './dto/list-users.dto.js';
import { UserListService } from './user-list.service.js';

/**
 * Список пользователей для администратора.
 *
 * Адрес /admin/users, а не /users с правом: раздел администратора в
 * проекте уже живёт под /admin/* (там же /admin/rbac/*), и по адресу сразу
 * видно, что окно не для всех. Плюс /users занят карточкой одного
 * пользователя, и список рядом с ней читался бы хуже.
 *
 * Право проверяется внутри сервиса, а не наклейкой @RequirePermission:
 * так отказ попадает в журнал вместе с параметрами запроса, чего требует
 * п. 1.5 ТЗ.
 */
@ApiTags('Администратор: пользователи')
@ApiCookieAuth('access_token')
@Controller('admin/users')
@UseGuards(RateLimitGuard, JwtAuthGuard)
export class UserListController {
  constructor(private readonly userList: UserListService) {}

  /**
   * GET /admin/users?limit=&cursor=&q=&status=&sort=&order=
   *
   * Лимит по адресу клиента — грубая сеть; персональный, по аккаунту,
   * стоит в UserRateLimits: выборка со фильтрами дороже обычного чтения.
   */
  @ApiOperation({
    summary: 'Список пользователей',
    description:
      'Требует право users@list. Пагинация курсорная: nextCursor из ответа ' +
      'передайте в cursor следующего запроса. Полный адрес почты открывает ' +
      'право users@read_email, иначе он замаскирован.',
  })
  @ApiZodQuery(listUsersSchema)
  @ApiResponse({ status: 200, description: 'items + nextCursor' })
  @ApiResponse({
    status: 400,
    description: 'Некорректные параметры или курсор',
  })
  @ApiResponse({ status: 401, description: 'Нет или невалиден токен' })
  @ApiResponse({ status: 403, description: 'Нет права users@list' })
  @ApiResponse({ status: 429, description: 'Превышен лимит запросов' })
  @Get()
  @RateLimit({ limit: 60, windowSeconds: 60 })
  list(
    @Query(new ZodValidationPipe(listUsersSchema)) query: ListUsersDto,
    @CurrentUser() me: User,
  ): Promise<UserListPage> {
    return this.userList.list(me, query);
  }
}
