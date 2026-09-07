import * as z from 'zod';

// Список настроек, которые приложение читает из файла .env.
// Если что-то заполнено неправильно — приложение не запустится и скажет, что не так.
export const envSchema = z.object({
  // Приложение
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.url().default('http://localhost:3000'),

  // База данных
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USERNAME: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
  DB_SYNCHRONIZE: z.stringbool().default(false),
  DB_LOGGING: z.stringbool().default(false),

  // Почта (turboSMTP)
  // console — письма печатаются в консоль, smtp — уходят по-настоящему
  MAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  SMTP_HOST: z.string().default('pro.turbo-smtp.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().min(1).default('Course App <no-reply@example.com>'),

  // Пароли и коды подтверждения
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  // Токены входа (JWT)
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'Секрет должен быть не короче 32 символов'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'Секрет должен быть не короче 32 символов'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  COOKIE_SECURE: z.stringbool().default(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // Первый администратор: этому пользователю при старте выдаётся роль admin.
  // Пусто — никому ничего не выдаётся. 
  RBAC_BOOTSTRAP_ADMIN_EMAIL: z.string().default(''),

  // Просмотр чужих профилей: сколько штук за сколько секунд с одного
  // аккаунта. Защита от выкачивания базы пользователей.
  PROFILE_FOREIGN_READ_LIMIT: z.coerce.number().int().positive().default(20),
  PROFILE_FOREIGN_READ_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),

  // Папка для загруженных файлов
  UPLOAD_DIR: z.string().min(1).default('./storage/uploads'),
});

// Тип настроек — берётся из схемы выше автоматически.
export type Env = z.infer<typeof envSchema>;

// Эту функцию приложение вызывает при запуске, чтобы проверить .env
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`Некорректные переменные окружения:\n${details}`);
  }

  return result.data;
}
