import type { ImageConverter } from '../image-converter.js';
import { RASTER_FORMATS } from '../image-format.js';
import { RasterConverter } from './raster.converter.js';
import { RasterizeConverter } from './rasterize.converter.js';

/**
 * Все поддерживаемые направления (п. 1.2 ТЗ).
 *
 * Список не пишется руками, а собирается из видов форматов:
 *
 *   растр → растр   — все пары разных растровых форматов;
 *   вектор → растр  — растеризатор SVG в каждый растровый формат.
 *
 * Пары «растр → вектор» здесь нет — и в этом всё дело. Запрет из п. 1.2
 * ТЗ («векторизация не поддерживается никогда») держится не проверкой,
 * которую однажды забудут поправить, а тем, что такое направление неоткуда
 * взять: правил сборки всего два, и ни одно из них не ведёт в вектор.
 *
 * Пара «формат в себя же» (png → png) пропущена намеренно: это не
 * конвертация, а пережатие, и в ТЗ его нет.
 *
 * Счёт сейчас: два растровых формата и один векторный дают четыре
 * направления — ровно те, что перечислены в ТЗ.
 */
export const CONVERTERS: readonly ImageConverter[] = [
  ...RASTER_FORMATS.flatMap((source) =>
    RASTER_FORMATS.filter((target) => target !== source).map(
      (target) => new RasterConverter(source, target),
    ),
  ),
  ...RASTER_FORMATS.map((target) => new RasterizeConverter(target)),
];

/** Найти направление. undefined — оно не поддерживается. */
export function findConverter(
  source: string,
  target: string,
): ImageConverter | undefined {
  return CONVERTERS.find((c) => c.source === source && c.target === target);
}
