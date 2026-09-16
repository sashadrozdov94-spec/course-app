import * as z from 'zod';
import { FileFormat } from '../format.js';

/**
 * Поля формы, кроме самого файла.
 *
 * Файл проверяется отдельно: он приходит не в теле, а через multipart, и
 * его разбирает multer до того, как схема увидит остальные поля.
 */
export const convertSchema = z.object({
  targetFormat: z.enum(FileFormat, {
    error: 'Укажите целевой формат: csv, json, xml или yaml',
  }),

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

export type ConvertDto = z.infer<typeof convertSchema>;
