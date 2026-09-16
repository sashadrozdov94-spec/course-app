import * as z from 'zod';
import { FileFormat } from '../../convert/format.js';
import { ImageFormat } from '../../images/image-format.js';
import {
  TransformationStatus,
  TransformationType,
  UNKNOWN_FORMAT,
} from '../transformation.js';

/** Границы страницы из п. 1.3.1 ТЗ: до 100, по умолчанию 20. */
export const PAGE_SIZE_MIN = 1;
export const PAGE_SIZE_MAX = 100;
export const PAGE_SIZE_DEFAULT = 20;

/**
 * Форматы, по которым разрешено фильтровать.
 *
 * Список не переписан руками, а собран из перечислений обоих модулей:
 * появится новый формат — он станет фильтруемым сам, и никто не забудет
 * дописать его сюда. Это единственное место, где словари форматов
 * встречаются: в самой таблице формат — просто строка (см. entity), и
 * знать про csv и png базе незачем.
 *
 * Импортируются именно перечисления — файлы без зависимостей, — а не
 * сервисы конвертации: обратной связи с этим модулем у них нет, поэтому
 * кольца импортов не возникает.
 *
 * UNKNOWN_FORMAT тоже фильтруется: «покажи, что у нас не опознаётся» —
 * осмысленный вопрос, и без него такие записи из выборки не достать.
 */
export const HISTORY_FORMATS = [
  ...Object.values(FileFormat),
  ...Object.values(ImageFormat),
  UNKNOWN_FORMAT,
] as const;

/**
 * Момент времени в фильтре по периоду.
 *
 * Принимаем и дату («2025-01-31»), и полное время со смещением
 * («2025-01-31T12:00:00Z»). Дата без времени — это полночь UTC.
 *
 * Время без смещения не принимаем намеренно: «2025-01-31T12:00:00» в
 * разных часовых поясах означает разные моменты, и угадывать за клиента,
 * какой он имел в виду, — верный способ отдать не тот период. Пусть
 * скажет явно.
 */
const moment = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()], {
    error:
      'Дата в виде 2025-01-31 или момент со смещением 2025-01-31T12:00:00Z',
  })
  .transform((value) => new Date(value));

/**
 * Параметры выборки истории (п. 1.3.1 ТЗ).
 *
 * strictObject: незнакомый параметр — отказ, а не тишина. Опечатка в
 * «staus» иначе просто не отфильтровала бы ничего, и человек решил бы,
 * что записей нет.
 *
 * Одна и та же схема у своей истории и у административной (п. 1.3.2 ТЗ
 * говорит «аналогично»): разница между ними в том, чью историю смотрят, а
 * не в том, как её фильтровать.
 */
export const listHistorySchema = z
  .strictObject({
    // Курсор непрозрачен для клиента: он его только возвращает как получил
    cursor: z.string().max(512).optional(),

    // z.coerce, потому что из строки запроса всё приходит строками
    limit: z.coerce
      .number()
      .int()
      .min(PAGE_SIZE_MIN, `Минимум ${PAGE_SIZE_MIN}`)
      .max(PAGE_SIZE_MAX, `Максимум ${PAGE_SIZE_MAX}`)
      .default(PAGE_SIZE_DEFAULT),

    type: z.enum(TransformationType).optional(),

    sourceFormat: z.enum(HISTORY_FORMATS).optional(),
    targetFormat: z.enum(HISTORY_FORMATS).optional(),

    status: z.enum(TransformationStatus).optional(),

    createdAtFrom: moment.optional(),
    createdAtTo: moment.optional(),
  })
  .refine(
    (query) =>
      !query.createdAtFrom ||
      !query.createdAtTo ||
      query.createdAtFrom <= query.createdAtTo,
    {
      // Пустой ответ на перевёрнутый период выглядел бы как «ничего не
      // было», хотя на деле спрошено невозможное
      error: 'Начало периода позже его конца',
      path: ['createdAtFrom'],
    },
  );

export type ListHistoryDto = z.infer<typeof listHistorySchema>;

/**
 * Одна строка истории (п. 1.3.1 ТЗ).
 *
 * Имени файла здесь нет: в контракте его не заявлено, а через
 * административное окно видны чужие записи — п. 1.4 ТЗ просит не
 * раскрывать о других лишнего. В таблице имя лежит, для разбора
 * происшествий.
 */
export interface TransformationHistoryItem {
  id: string;
  type: TransformationType;
  sourceFormat: string;
  targetFormat: string;
  status: TransformationStatus;
  /** Размер исходного файла в байтах. */
  fileSize: number;
  durationMs: number;
  /** Только у отказов. Код ответа, которым закончилась попытка. */
  errorCode?: string;
  createdAt: Date;
  /**
   * Есть ли файл, который можно скачать прямо сейчас.
   *
   * Не «сохраняли ли» — а именно «можно ли скачать»: у записи с истёкшим
   * сроком файла уже нет, и показывать по ней кнопку скачивания значило
   * бы обещать лишнее.
   */
  saved: boolean;
  /** До каких пор файл доступен. null — файла нет или он бессрочный. */
  expiresAt: Date | null;
}

export interface TransformationHistoryPage {
  items: TransformationHistoryItem[];
  nextCursor: string | null;
}
