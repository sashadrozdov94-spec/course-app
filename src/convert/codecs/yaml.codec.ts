import { parseDocument, stringify } from 'yaml';
import { FileFormat } from '../format.js';
import { FormatCodec } from './format-codec.js';

/**
 * Сколько раз разрешено раскрыть якоря (&anchor / *alias).
 *
 * Это защита от «YAML bomb» — того же приёма, что и billion laughs в XML:
 * десяток строк с вложенными ссылками раскрывается в гигабайты данных и
 * кладёт процесс по памяти. Значение библиотеки по умолчанию; ставим явно,
 * чтобы смена умолчания в новой версии не сняла защиту молча.
 */
const MAX_ALIAS_COUNT = 100;

/**
 * YAML 1.2.
 *
 * Соглашения для неоднозначных мест (п. 1.4 ТЗ):
 *
 *   версия         — 1.2 задана явно. В 1.1 строки yes/no/on/off читались
 *                    как логические, из-за чего страна NO (Норвегия)
 *                    превращалась в false. В 1.2 таких сюрпризов нет;
 *   типы           — базовая схема (core): числа, логические, null и
 *                    строки. Дат нет — в 1.2 они не входят в ядро, и
 *                    строка 2024-01-01 остаётся строкой, то есть переживёт
 *                    переход в JSON без потерь;
 *   якоря и ссылки — раскрываются при чтении, с ограничением выше; в
 *                    результате получается обычное дерево без ссылок;
 *   повторяющиеся ключи — ошибка, а не «побеждает последний»: это почти
 *                    всегда опечатка, и тихо терять данные хуже, чем
 *                    отказать;
 *   при записи     — отступ 2 пробела, длинные строки не переносятся
 *                    (lineWidth: 0). Перенос менял бы содержимое строки
 *                    при обратном чтении.
 */
export class YamlCodec extends FormatCodec {
  readonly format = FileFormat.Yaml;

  parse(input: string): unknown {
    // Разбираем документом, а не сокращением parse(): при logLevel:
    // 'silent' — а он нужен, чтобы замечания о чужом файле не сыпались в
    // журнал сервера — parse() проглатывает и сами ошибки и возвращает
    // разобранное наполовину. Здесь список ошибок виден, и решение
    // принимаем сами.
    const document = parseDocument(input, {
      version: '1.2',
      schema: 'core',
      uniqueKeys: true,
      // Ссылки на «родителя» (<<) — расширение 1.1, в 1.2 его нет
      merge: false,
      // Большие целые не превращаем в BigInt: JSON.stringify их не умеет
      intAsBigInt: false,
      logLevel: 'silent',
    });

    if (document.errors.length > 0) {
      throw new Error(
        `Некорректный YAML: ${document.errors[0]!.message.slice(0, 200)}`,
      );
    }

    // Документ из одних комментариев синтаксически верен, но данных в нём
    // нет. Пустоту нужно поймать здесь: дальше она расползётся по
    // сериализаторам и обернётся невнятной ошибкой. Явно написанный null —
    // это наполнение документа, а не пустота, и сюда не попадает.
    if (document.contents === null) {
      throw new Error('YAML не содержит данных');
    }

    try {
      return document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
    } catch (error) {
      // Сюда приходит превышение MAX_ALIAS_COUNT — то есть YAML-бомба
      throw new Error(
        `YAML не удалось развернуть: ${(error as Error).message.slice(0, 200)}`,
      );
    }
  }

  serialize(value: unknown): string {
    if (value === undefined) {
      throw new Error('Нечего записывать: данные пусты');
    }

    return stringify(value, {
      version: '1.2',
      schema: 'core',
      indent: 2,
      lineWidth: 0,
    });
  }
}
