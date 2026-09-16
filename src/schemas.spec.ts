import {
  confirmLinkSchema,
  confirmOtpSchema,
  resendSchema,
} from './auth/dto/confirm.dto.js';
import { loginSchema } from './auth/dto/login.dto.js';
import { registerSchema } from './auth/dto/register.dto.js';
import { convertSchema } from './convert/dto/convert.dto.js';
import { convertImageSchema } from './images/dto/convert-image.dto.js';
import {
  createGrantSchema,
  grantIdParamSchema,
  toGrantView,
  updateGrantSchema,
} from './rbac/dto/grant.dto.js';
import { forceQuerySchema, identifierSchema } from './rbac/dto/identifiers.js';
import {
  createPermissionSchema,
  permissionIdParamSchema,
  toPermissionView,
  updatePermissionSchema,
} from './rbac/dto/permission.dto.js';
import {
  createRoleSchema,
  roleIdParamSchema,
  toRoleView,
  updateRoleSchema,
} from './rbac/dto/role.dto.js';
import type { Grant } from './rbac/entities/grant.entity.js';
import type { Permission } from './rbac/entities/permission.entity.js';
import type { Role } from './rbac/entities/role.entity.js';
import { itemIdParamSchema } from './transformations/dto/item-id.dto.js';
import {
  listUsersSchema,
  maskEmail,
} from './users/admin-list/dto/list-users.dto.js';
import {
  confirmDeletionSchema,
  deleteUserSchema,
} from './users/deletion/dto/delete-user.dto.js';
import {
  confirmEmailChangeSchema,
  emailChangeSchema,
} from './users/email-change/dto/email-change.dto.js';
import { type User, UserStatus } from './users/entities/user.entity.js';
import {
  buildProfileView,
  fieldsForActions,
  PROFILE_FIELDS,
  SELF_PROFILE_FIELDS,
} from './users/profile/dto/profile-view.js';
import {
  PROFILE_UPDATE_POLICY,
  toColumnPatch,
  updateProfileSchema,
} from './users/profile/dto/update-profile.dto.js';
import { userIdParamSchema } from './users/shared/user-id.dto.js';
import { USERS_ACTIONS } from './users/shared/users-permission.js';

/**
 * Схемы запросов со всего приложения.
 *
 * Собраны в один файл не для удобства, а потому, что проверяют они одно и
 * то же: границу между клиентом и приложением. Всё, что пришло снаружи,
 * должно быть либо приведено к ожидаемому виду, либо отвергнуто с
 * понятным текстом — третьего не дано.
 */

/** Настоящий UUID четвёртой версии: короткие подделки схемы не принимают. */
const UUID = '11111111-2222-4333-8444-555555555555';

describe('Вход и регистрация', () => {
  it('адрес почты приводится к нижнему регистру и без пробелов', () => {
    // Bob@Mail.com и bob@mail.com — это один человек
    expect(
      loginSchema.parse({ email: '  Bob@Mail.COM ', password: 'x' }).email,
    ).toBe('bob@mail.com');
  });

  it('вход не принимает пустой пароль и не-адрес', () => {
    expect(
      loginSchema.safeParse({ email: 'a@b.c', password: '' }).success,
    ).toBe(false);
    expect(
      loginSchema.safeParse({ email: 'не почта', password: 'x' }).success,
    ).toBe(false);
  });

  describe('Требования к паролю при регистрации', () => {
    const good = { email: 'a@b.com', password: 'parol123' };

    it('принимает пароль с буквой и цифрой', () => {
      expect(registerSchema.safeParse(good).success).toBe(true);
    });

    it.each([
      ['короткий', 'ab1'],
      ['длинный', `${'a'.repeat(64)}1`],
      ['без цифр', 'парольбезцифр'],
      ['без букв', '12345678'],
    ])('не принимает %s', (_name, password) => {
      expect(registerSchema.safeParse({ ...good, password }).success).toBe(
        false,
      );
    });

    it('не принимает слишком длинный адрес', () => {
      const long = `${'a'.repeat(320)}@b.com`;

      expect(registerSchema.safeParse({ ...good, email: long }).success).toBe(
        false,
      );
    });
  });

  describe('Подтверждение', () => {
    it('код — это только цифры, от четырёх до десяти', () => {
      expect(
        confirmOtpSchema.safeParse({ attemptId: UUID, code: ' 123456 ' }).data
          ?.code,
      ).toBe('123456');
      expect(
        confirmOtpSchema.safeParse({ attemptId: UUID, code: '12ab' }).success,
      ).toBe(false);
      expect(
        confirmOtpSchema.safeParse({ attemptId: UUID, code: '123' }).success,
      ).toBe(false);
    });

    it('номер попытки должен быть настоящим UUID', () => {
      expect(
        confirmOtpSchema.safeParse({ attemptId: 'нет', code: '1234' }).success,
      ).toBe(false);
      expect(resendSchema.safeParse({ attemptId: UUID }).success).toBe(true);
    });

    it('токен из письма не бывает коротким', () => {
      expect(confirmLinkSchema.safeParse({ token: 'abc' }).success).toBe(false);
      expect(
        confirmLinkSchema.safeParse({ token: 'a'.repeat(40) }).success,
      ).toBe(true);
    });
  });
});

describe('Имена ролей и разрешений', () => {
  it.each(['users', 'read_email', 'history-admin', 'a1'])(
    'принимает «%s»',
    (name) => {
      expect(identifierSchema.safeParse(name).success).toBe(true);
    },
  );

  it.each([
    ['с заглавной', 'Users'],
    ['с цифры', '1users'],
    ['с пробелом', 'read email'],
    ['пустое', ''],
    ['с точкой', 'users.read'],
  ])('не принимает %s', (_name, value) => {
    expect(identifierSchema.safeParse(value).success).toBe(false);
  });
});

describe('Раздел администратора RBAC', () => {
  it('создание роли требует имени, описание необязательно', () => {
    expect(createRoleSchema.safeParse({ name: 'support' }).success).toBe(true);
    expect(createRoleSchema.safeParse({ name: 'Support' }).success).toBe(false);
  });

  it('правка без единого поля — отказ, а не пустая операция', () => {
    expect(updateRoleSchema.safeParse({}).success).toBe(false);
    expect(updatePermissionSchema.safeParse({}).success).toBe(false);
    expect(updateGrantSchema.safeParse({}).success).toBe(false);
  });

  it('у разрешения должно быть хотя бы одно действие', () => {
    expect(
      createPermissionSchema.safeParse({ name: 'users', actions: [] }).success,
    ).toBe(false);
    expect(
      createPermissionSchema.safeParse({ name: 'users', actions: ['read'] })
        .success,
    ).toBe(true);
  });

  it('действия не должны повторяться', () => {
    expect(
      createPermissionSchema.safeParse({
        name: 'users',
        actions: ['read', 'read'],
      }).success,
    ).toBe(false);
  });

  it('назначение ссылается на роль и разрешение номерами', () => {
    expect(
      createGrantSchema.safeParse({ roleId: UUID, permissionId: UUID }).success,
    ).toBe(true);
    expect(
      createGrantSchema.safeParse({ roleId: 'нет', permissionId: UUID })
        .success,
    ).toBe(false);
  });

  it.each([
    ['роли', roleIdParamSchema, 'roleId'],
    ['разрешения', permissionIdParamSchema, 'permissionId'],
    ['назначения', grantIdParamSchema, 'grantId'],
    ['пользователя', userIdParamSchema, 'userId'],
    ['записи истории', itemIdParamSchema, 'itemId'],
  ])(
    'номер %s из адреса проверяется до похода в базу',
    (_name, schema, key) => {
      expect(schema.safeParse({ [key]: UUID }).success).toBe(true);
      expect(schema.safeParse({ [key]: 'не-номер' }).success).toBe(false);
    },
  );

  it('флаг force приходит строкой и становится логическим', () => {
    expect(forceQuerySchema.parse({}).force).toBe(false);
    expect(forceQuerySchema.parse({ force: 'true' }).force).toBe(true);
  });

  describe('Ответы администратору', () => {
    it('роль отдаётся без лишних полей', () => {
      expect(
        toRoleView({
          id: 'r1',
          name: 'support',
          description: null,
        } as unknown as Role),
      ).toEqual({ id: 'r1', name: 'support', description: null });
    });

    it('разрешение отдаётся со списком действий', () => {
      expect(
        toPermissionView({
          id: 'p1',
          name: 'users',
          actions: ['read'],
        } as unknown as Permission),
      ).toEqual({ id: 'p1', name: 'users', actions: ['read'] });
    });

    it('у назначения видно, что пустой список — это «все действия»', () => {
      expect(
        toGrantView({
          id: 'g1',
          roleId: 'r1',
          permissionId: 'p1',
          actions: [],
        } as unknown as Grant),
      ).toMatchObject({ allActions: true });

      expect(
        toGrantView({
          id: 'g1',
          roleId: 'r1',
          permissionId: 'p1',
          actions: ['read'],
        } as unknown as Grant),
      ).toMatchObject({ allActions: false });
    });
  });
});

describe('Список пользователей', () => {
  it('без параметров берёт значения по умолчанию', () => {
    const query = listUsersSchema.parse({});

    expect(query.limit).toBe(20);
    expect(query.sort).toBe('created_at');
    expect(query.order).toBe('desc');
  });

  it('держит размер страницы в границах из ТЗ', () => {
    expect(listUsersSchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listUsersSchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listUsersSchema.parse({ limit: '100' }).limit).toBe(100);
  });

  it('сортировать можно только по объявленным полям', () => {
    // Иначе клиент задавал бы произвольное выражение в ORDER BY
    expect(listUsersSchema.safeParse({ sort: 'email' }).success).toBe(true);
    expect(listUsersSchema.safeParse({ sort: 'password_hash' }).success).toBe(
      false,
    );
  });

  it('незнакомый параметр — отказ', () => {
    expect(listUsersSchema.safeParse({ staus: 'active' }).success).toBe(false);
  });

  describe('Маскировка адреса', () => {
    it('оставляет две буквы и домен', () => {
      // Столько, чтобы администратор узнал знакомый адрес, но не мог
      // выгрузить список рабочих адресов
      expect(maskEmail('ivan@example.com')).toBe('iv***@example.com');
    });

    it('справляется с коротким именем', () => {
      expect(maskEmail('a@b.com')).toBe('a***@b.com');
    });

    it('строку без собаки прячет целиком', () => {
      expect(maskEmail('вообще не адрес')).toBe('***');
      expect(maskEmail('@b.com')).toBe('***');
    });
  });
});

describe('Правка профиля', () => {
  it('правка без единого поля — отказ', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });

  it('фото можно снять, передав null', () => {
    expect(updateProfileSchema.parse({ photo: null }).photo).toBeNull();
  });

  it('незнакомое поле — отказ, а не тихое игнорирование', () => {
    expect(updateProfileSchema.safeParse({ passwordHash: 'x' }).success).toBe(
      false,
    );
  });

  it('поля контракта переводятся в колонки базы', () => {
    // В базе колонка avatarUrl, в контракте из ТЗ — photo
    expect(
      toColumnPatch({
        photo: 'a.png',
        status: UserStatus.Blocked,
        email: 'a@b.com',
      }),
    ).toEqual({
      avatarUrl: 'a.png',
      status: UserStatus.Blocked,
      email: 'a@b.com',
    });
  });

  it('переводится только то, что прислали', () => {
    expect(toColumnPatch({ photo: null })).toEqual({ avatarUrl: null });
  });

  it('себе можно менять только фото', () => {
    // Статус и почта себе — через отдельные сценарии со своими проверками
    expect(PROFILE_UPDATE_POLICY.self).toEqual(['photo']);
    expect(PROFILE_UPDATE_POLICY.update).toContain('email');
  });
});

describe('Какие поля профиля показывать', () => {
  const user = {
    id: 'u1',
    email: 'a@b.com',
    avatarUrl: 'a.png',
    status: UserStatus.Active,
    emailVerifiedAt: new Date('2025-01-01'),
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-02'),
  } as User;

  it('базовое право не открывает почту', () => {
    const fields = fieldsForActions([USERS_ACTIONS.Read]);

    expect(fields.has('email')).toBe(false);
    expect(fields.has('id')).toBe(true);
  });

  it('право на почту добавляет её к остальным', () => {
    const fields = fieldsForActions([
      USERS_ACTIONS.Read,
      USERS_ACTIONS.ReadEmail,
    ]);

    expect(fields.has('email')).toBe(true);
  });

  it('незнакомое действие не открывает ничего', () => {
    // default-deny: неизвестное — значит запрещённое
    expect(fieldsForActions(['сделать-всё']).size).toBe(0);
  });

  it('в ответ попадают только разрешённые поля, без null-заглушек', () => {
    const view = buildProfileView(user, fieldsForActions([USERS_ACTIONS.Read]));

    expect(Object.keys(view).sort()).toEqual([
      'createdAt',
      'id',
      'photo',
      'status',
    ]);
    expect('email' in view).toBe(false);
  });

  it('себе видно всё', () => {
    const view = buildProfileView(user, new Set(SELF_PROFILE_FIELDS));

    expect(Object.keys(view).sort()).toEqual([...PROFILE_FIELDS].sort());
    expect(view.photo).toBe('a.png');
  });
});

describe('Смена почты и удаление аккаунта', () => {
  it('новая почта приводится к нижнему регистру', () => {
    expect(emailChangeSchema.parse({ newEmail: ' A@B.COM ' }).newEmail).toBe(
      'a@b.com',
    );
  });

  it('не принимает не-адрес и лишние поля', () => {
    expect(emailChangeSchema.safeParse({ newEmail: 'нет' }).success).toBe(
      false,
    );
    expect(
      emailChangeSchema.safeParse({ newEmail: 'a@b.com', force: true }).success,
    ).toBe(false);
  });

  it('причина удаления необязательна, но ограничена по длине', () => {
    expect(deleteUserSchema.safeParse({}).success).toBe(true);
    expect(
      deleteUserSchema.safeParse({ reason: 'ж'.repeat(256) }).success,
    ).toBe(false);
  });

  it.each([
    ['удаления', confirmDeletionSchema],
    ['смены почты', confirmEmailChangeSchema],
  ])('подтверждение %s требует номер попытки и код', (_name, schema) => {
    expect(
      schema.safeParse({ challengeId: UUID, code: '123456' }).success,
    ).toBe(true);
    expect(schema.safeParse({ challengeId: UUID, code: '1' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ challengeId: 'нет', code: '1234' }).success).toBe(
      false,
    );
  });
});

describe('Поля формы конвертации', () => {
  it('целевой формат обязателен и из списка', () => {
    expect(convertSchema.safeParse({ targetFormat: 'json' }).success).toBe(
      true,
    );
    expect(convertSchema.safeParse({ targetFormat: 'docx' }).success).toBe(
      false,
    );
  });

  it('флаг сохранения приходит строкой и по умолчанию выключен', () => {
    expect(convertSchema.parse({ targetFormat: 'json' }).save).toBe(false);
    expect(
      convertSchema.parse({ targetFormat: 'json', save: 'true' }).save,
    ).toBe(true);
    expect(
      convertImageSchema.parse({ targetFormat: 'png', save: 'false' }).save,
    ).toBe(false);
  });

  it('options приходит записью JSON строкой', () => {
    // Вложенных объектов в multipart не бывает
    const dto = convertImageSchema.parse({
      targetFormat: 'png',
      options: '{"width":512}',
    });

    expect(dto.options).toEqual({ width: 512 });
  });

  it('пустая строка options означает «параметров нет»', () => {
    expect(
      convertImageSchema.parse({ targetFormat: 'png', options: '' }).options,
    ).toEqual({});
  });

  it('options не в JSON — понятный отказ, а не «ожидался объект»', () => {
    const result = convertImageSchema.safeParse({
      targetFormat: 'png',
      options: 'width=512',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]!.message).toContain('JSON');
  });

  it('незнакомое поле в options — отказ', () => {
    expect(
      convertImageSchema.safeParse({
        targetFormat: 'png',
        options: '{"heigth":10}',
      }).success,
    ).toBe(false);
  });

  it('качество держится в границах 1–100', () => {
    expect(
      convertImageSchema.safeParse({
        targetFormat: 'jpeg',
        options: '{"quality":0}',
      }).success,
    ).toBe(false);
    expect(
      convertImageSchema.parse({
        targetFormat: 'jpeg',
        options: '{"quality":100}',
      }).options.quality,
    ).toBe(100);
  });

  it('цвет фона проверяется по виду', () => {
    expect(
      convertImageSchema.parse({
        targetFormat: 'png',
        options: '{"background":"transparent"}',
      }).options.background,
    ).toBe('transparent');
    expect(
      convertImageSchema.safeParse({
        targetFormat: 'png',
        options: '{"background":"красный"}',
      }).success,
    ).toBe(false);
  });

  it('размеры — целые и больше нуля', () => {
    expect(
      convertImageSchema.safeParse({
        targetFormat: 'png',
        options: '{"width":0}',
      }).success,
    ).toBe(false);
    expect(
      convertImageSchema.safeParse({
        targetFormat: 'png',
        options: '{"height":10.5}',
      }).success,
    ).toBe(false);
  });
});
