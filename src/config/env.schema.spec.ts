import { validateEnv } from './env.schema.js';

/**
 * Минимум, без которого приложение не поднимется.
 *
 * Всё остальное имеет значения по умолчанию — и это проверяется ниже
 * отдельно: список обязательных переменных должен оставаться коротким,
 * иначе развернуть приложение становится квестом.
 */
const REQUIRED = {
  DB_HOST: 'localhost',
  DB_USERNAME: 'postgres',
  DB_PASSWORD: 'secret',
  DB_NAME: 'course_app',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

/** Сообщение об ошибке целиком — по нему человек и чинит .env. */
function errorFor(raw: Record<string, unknown>): string {
  try {
    validateEnv(raw);
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('ожидался отказ, но настройки приняты');
}

describe('Проверка настроек при старте', () => {
  it('минимального набора хватает, остальное берётся по умолчанию', () => {
    const env = validateEnv({ ...REQUIRED });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.DB_PORT).toBe(5432);
    expect(env.MAIL_DRIVER).toBe('console');
    expect(env.UPLOAD_DIR).toBe('./assets');
  });

  it('числа приходят строками и становятся числами', () => {
    // Всё в .env — текст, и без приведения PORT сравнивался бы как строка
    const env = validateEnv({ ...REQUIRED, PORT: '8080', DB_PORT: '6543' });

    expect(env.PORT).toBe(8080);
    expect(env.DB_PORT).toBe(6543);
  });

  it('логические значения читаются из слов', () => {
    const env = validateEnv({
      ...REQUIRED,
      DB_SYNCHRONIZE: 'true',
      DB_LOGGING: 'false',
      COOKIE_SECURE: 'true',
    });

    expect(env.DB_SYNCHRONIZE).toBe(true);
    expect(env.DB_LOGGING).toBe(false);
    expect(env.COOKIE_SECURE).toBe(true);
  });

  describe('Отказ вместо запуска с плохими настройками', () => {
    it('называет все недостающие переменные разом', () => {
      const message = errorFor({});

      // Чинить .env по одной переменной за запуск — то ещё удовольствие
      expect(message).toContain('DB_HOST');
      expect(message).toContain('DB_NAME');
      expect(message).toContain('JWT_ACCESS_SECRET');
    });

    it('не принимает короткий секрет токенов', () => {
      const message = errorFor({
        ...REQUIRED,
        JWT_ACCESS_SECRET: 'слишком короткий',
      });

      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).toContain('32');
    });

    it('не принимает нечисло там, где ждут число', () => {
      expect(errorFor({ ...REQUIRED, PORT: 'восемьдесят' })).toContain('PORT');
    });

    it('не принимает отрицательный порт', () => {
      expect(errorFor({ ...REQUIRED, PORT: '-1' })).toContain('PORT');
    });

    it('не принимает незнакомый способ отправки почты', () => {
      expect(errorFor({ ...REQUIRED, MAIL_DRIVER: 'голубь' })).toContain(
        'MAIL_DRIVER',
      );
    });

    it('не принимает адрес приложения, который не адрес', () => {
      expect(errorFor({ ...REQUIRED, APP_URL: 'не-ссылка' })).toContain(
        'APP_URL',
      );
    });
  });

  describe('Настройки конвертации', () => {
    it('лимиты размера у каждого формата свои и заданы по умолчанию', () => {
      const env = validateEnv({ ...REQUIRED });

      expect(env.CONVERT_MAX_CSV_BYTES).toBeGreaterThan(0);
      expect(env.CONVERT_MAX_JSON_BYTES).toBeGreaterThan(0);
      expect(env.IMAGE_MAX_PNG_BYTES).toBeGreaterThan(0);
      // У SVG планка ниже: мегабайт разметки описывает картинку, на
      // которую растру не хватило бы и сотни мегабайт
      expect(env.IMAGE_MAX_SVG_BYTES).toBeLessThan(env.IMAGE_MAX_PNG_BYTES);
    });

    it('качество JPEG держится в границах 1–100', () => {
      expect(validateEnv({ ...REQUIRED }).IMAGE_JPEG_QUALITY).toBe(80);
      expect(errorFor({ ...REQUIRED, IMAGE_JPEG_QUALITY: '0' })).toContain(
        'IMAGE_JPEG_QUALITY',
      );
      expect(errorFor({ ...REQUIRED, IMAGE_JPEG_QUALITY: '101' })).toContain(
        'IMAGE_JPEG_QUALITY',
      );
    });

    it('цвет холста проверяется прямо при старте', () => {
      // Опечатка иначе всплыла бы отказом библиотеки на первой картинке
      expect(validateEnv({ ...REQUIRED }).IMAGE_BACKGROUND).toBe('#ffffff');
      expect(
        validateEnv({ ...REQUIRED, IMAGE_BACKGROUND: 'transparent' })
          .IMAGE_BACKGROUND,
      ).toBe('transparent');
      expect(errorFor({ ...REQUIRED, IMAGE_BACKGROUND: 'красный' })).toContain(
        'IMAGE_BACKGROUND',
      );
    });
  });

  describe('Настройки истории', () => {
    it('срок хранения по умолчанию 90 дней', () => {
      expect(
        validateEnv({ ...REQUIRED }).TRANSFORMATION_HISTORY_RETENTION_DAYS,
      ).toBe(90);
    });

    it('ноль разрешён: он означает «не удалять ничего»', () => {
      expect(
        validateEnv({
          ...REQUIRED,
          TRANSFORMATION_HISTORY_RETENTION_DAYS: '0',
        }).TRANSFORMATION_HISTORY_RETENTION_DAYS,
      ).toBe(0);
    });

    it('отрицательный срок хранения не принимается', () => {
      expect(
        errorFor({ ...REQUIRED, TRANSFORMATION_HISTORY_RETENTION_DAYS: '-1' }),
      ).toContain('TRANSFORMATION_HISTORY_RETENTION_DAYS');
    });

    it('период уборки нулём быть не может: это остановка таймера', () => {
      expect(
        errorFor({ ...REQUIRED, TRANSFORMATION_HISTORY_CLEANUP_HOURS: '0' }),
      ).toContain('TRANSFORMATION_HISTORY_CLEANUP_HOURS');
    });
  });
});
