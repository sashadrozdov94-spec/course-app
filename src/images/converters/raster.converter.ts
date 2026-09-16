import {
  type ConversionSettings,
  type ConvertOptions,
  ImageConverter,
  type OptionName,
} from '../image-converter.js';
import type { ImageFormat } from '../image-format.js';
import { open, writerFor } from './encode.js';

/**
 * Перекодирование растра в растр: png → jpeg, jpeg → png (п. 1.2 ТЗ).
 *
 * Один класс на все такие направления, потому что работа у них одна и та
 * же: разжать пиксели и сжать их обратно другим способом. Отличается
 * только запись, а она вынесена в encode.ts и выбирается по целевому
 * формату. Отсюда и счёт: два растровых формата дают два направления,
 * третий добавит ещё четыре, а класс останется один.
 *
 * Размеры изображение сохраняет: перекодирование — это не
 * масштабирование, и width с height здесь не принимаются (accepts). Иначе
 * один и тот же параметр значил бы в разных направлениях разное.
 */
export class RasterConverter extends ImageConverter {
  constructor(
    readonly source: ImageFormat,
    readonly target: ImageFormat,
  ) {
    super();
  }

  get accepts(): readonly OptionName[] {
    return writerFor(this.target).accepts;
  }

  async convert(
    input: Buffer,
    options: ConvertOptions,
    settings: ConversionSettings,
  ): Promise<Buffer> {
    const writer = writerFor(this.target);

    // Проверка на «бомбу» встроена в open: лимит пикселей относится к
    // входу, а размер выхода здесь ему равен, так что второй проверки на
    // максимальные стороны не нужно — они и не менялись
    return writer.encode(open(input, settings), options, settings).toBuffer();
  }
}
