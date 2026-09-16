import * as z from 'zod';
import { BACKGROUND } from '../converters/encode.js';
import { ImageFormat } from '../image-format.js';

/** Границы качества JPEG из п. 1.3.1 ТЗ. */
export const QUALITY_MIN = 1;
export const QUALITY_MAX = 100;

/**
 * Поля options (п. 1.3.1 ТЗ).
 *
 * strictObject, а не обычный: незнакомое поле — это отказ, а не тишина.
 * Опечатка в «heigth» иначе просто не сработала бы, и разбираться, почему
 * картинка не того размера, пришлось бы на глаз.
 *
 * Верхних границ для width и height здесь нет намеренно: их задаёт
 * администратор в конфигурации, а схема о конфигурации не знает. Проверку
 * делает растеризация — там же, где становятся известны и собственные
 * размеры картинки (см. converters/rasterize.converter.ts).
 */
export const imageOptionsSchema = z.strictObject({
  quality: z.coerce
    .number()
    .int()
    .min(QUALITY_MIN, `Качество от ${QUALITY_MIN} до ${QUALITY_MAX}`)
    .max(QUALITY_MAX, `Качество от ${QUALITY_MIN} до ${QUALITY_MAX}`)
    .optional(),

  width: z.coerce
    .number()
    .int('Ширина — целое число пикселей')
    .positive('Ширина должна быть больше нуля')
    .optional(),

  height: z.coerce
    .number()
    .int('Высота — целое число пикселей')
    .positive('Высота должна быть больше нуля')
    .optional(),

  background: z
    .string()
    .trim()
    .regex(
      BACKGROUND,
      'Цвет фона: #rgb, #rgba, #rrggbb, #rrggbbaa или transparent',
    )
    .optional(),
});

/**
 * options в multipart приходит строкой.
 *
 * Иначе и быть не может: multipart/form-data — это плоский набор полей,
 * вложенных объектов в нём нет. ТЗ описывает options объектом, поэтому
 * клиент кладёт в поле его запись в JSON, а разбираем её мы.
 *
 * Пустая строка — это «поля нет»: браузерная форма отправляет так
 * незаполненное поле, и считать это ошибкой было бы придиркой.
 */
const optionsField = z
  .string()
  .transform((text, ctx) => {
    if (text.trim().length === 0) {
      return {};
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'options должен быть объектом JSON, например {"quality":80}',
      });

      return z.NEVER;
    }
  })
  .pipe(imageOptionsSchema);

/**
 * Поля формы, кроме самого файла.
 *
 * Файл проверяется отдельно: он приходит не в теле, а через multipart, и
 * его разбирает multer до того, как схема увидит остальные поля.
 */
export const convertImageSchema = z.object({
  /**
   * svg в списке есть, хотя ни одно направление в него не ведёт.
   *
   * Так написано в ТЗ, и это не описка: клиент имеет право попросить
   * невозможное и получить внятный отказ «png → svg не поддерживается»
   * вместо «такого формата не бывает». Формат бывает — не бывает
   * векторизации.
   */
  targetFormat: z.enum(ImageFormat, {
    error: 'Укажите целевой формат: png, jpeg или svg',
  }),

  options: optionsField.optional().default({}),

  /**
   * Сохранить результат в хранилище (п. 1.3.1 ТЗ).
   *
   * stringbool, потому что из multipart всё приходит строками: «true» и
   * «false» здесь — это текст, а не логические значения. По умолчанию
   * false: сохранение занимает место и живёт до конца срока хранения
   * истории, поэтому это осознанный выбор, а не поведение по умолчанию.
   */
  save: z.stringbool().default(false),
});

export type ConvertImageDto = z.infer<typeof convertImageSchema>;
export type ImageOptions = z.infer<typeof imageOptionsSchema>;
