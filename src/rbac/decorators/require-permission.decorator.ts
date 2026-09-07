import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSION_KEY = 'rbac:require-permission';

/**
 * Наклейка на метод контроллера: «сюда пускать только с этим правом».
 *
 *   @RequirePermission('users@read_any')
 *   @Get(':userId')
 *   findOne() { ... }
 *
 * Запись «ресурс@действие» — из ТЗ. Саму проверку делает PermissionsGuard,
 * наклейка только прикрепляет к методу строку, которую он прочитает.
 */
export const RequirePermission = (reference: string) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, reference);
