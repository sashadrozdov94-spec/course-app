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
});

export type ConvertDto = z.infer<typeof convertSchema>;
