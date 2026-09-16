import { decodeCursor, encodeCursor } from '../common/cursor.js';
import {
  HISTORY_FORMATS,
  listHistorySchema,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
} from './dto/list-history.dto.js';

/** Разобрать строку запроса схемой, как это делает пайп. */
function parse(query: Record<string, string>) {
  return listHistorySchema.safeParse(query);
}

/** Сообщения всех замечаний — по ним видно, что именно не понравилось. */
function messages(result: ReturnType<typeof parse>): string[] {
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
}

describe('Параметры выборки истории', () => {
  it('без параметров даёт страницу по умолчанию', () => {
    const result = parse({});

    expect(result.success).toBe(true);
    expect(result.data?.limit).toBe(PAGE_SIZE_DEFAULT);
  });

  it('размер страницы приходит строкой и становится числом', () => {
    expect(parse({ limit: '50' }).data?.limit).toBe(50);
  });

  it('не пускает размер страницы за границы из ТЗ', () => {
    expect(parse({ limit: '0' }).success).toBe(false);
    expect(parse({ limit: String(PAGE_SIZE_MAX + 1) }).success).toBe(false);
    expect(parse({ limit: '2.5' }).success).toBe(false);
  });

  it('незнакомый параметр — отказ, а не тишина', () => {
    // Опечатка иначе просто не отфильтровала бы ничего, и человек решил
    // бы, что записей нет
    expect(parse({ staus: 'error' }).success).toBe(false);
  });

  it('знает форматы обоих модулей', () => {
    for (const format of ['csv', 'json', 'xml', 'yaml', 'png', 'jpeg', 'svg']) {
      expect(HISTORY_FORMATS).toContain(format);
      expect(parse({ sourceFormat: format }).success).toBe(true);
    }
  });

  it('позволяет найти записи с неопознанным форматом', () => {
    expect(parse({ sourceFormat: 'unknown' }).success).toBe(true);
  });

  it('не принимает формат, которого нет ни в одном модуле', () => {
    expect(parse({ sourceFormat: 'gif' }).success).toBe(false);
  });

  it('принимает вид и статус только из перечислений', () => {
    expect(parse({ type: 'file' }).success).toBe(true);
    expect(parse({ type: 'image' }).success).toBe(true);
    expect(parse({ type: 'video' }).success).toBe(false);

    expect(parse({ status: 'success' }).success).toBe(true);
    expect(parse({ status: 'error' }).success).toBe(true);
    expect(parse({ status: 'pending' }).success).toBe(false);
  });

  it('принимает дату и момент со смещением', () => {
    expect(parse({ createdAtFrom: '2025-01-31' }).data?.createdAtFrom).toEqual(
      new Date('2025-01-31T00:00:00.000Z'),
    );
    expect(
      parse({ createdAtTo: '2025-01-31T12:00:00Z' }).data?.createdAtTo,
    ).toEqual(new Date('2025-01-31T12:00:00.000Z'));
  });

  it('не принимает время без смещения: это разный момент в разных поясах', () => {
    expect(parse({ createdAtFrom: '2025-01-31T12:00:00' }).success).toBe(false);
  });

  it('не принимает мусор вместо даты', () => {
    expect(parse({ createdAtFrom: 'вчера' }).success).toBe(false);
    expect(parse({ createdAtFrom: '2025-13-01' }).success).toBe(false);
  });

  it('отказывает на перевёрнутом периоде', () => {
    // Пустой ответ выглядел бы как «ничего не было», хотя спрошено
    // невозможное
    const result = parse({
      createdAtFrom: '2025-02-01',
      createdAtTo: '2025-01-01',
    });

    expect(result.success).toBe(false);
    expect(messages(result)).toContain('Начало периода позже его конца');
  });

  it('период из одного дня допустим', () => {
    expect(
      parse({ createdAtFrom: '2025-01-31', createdAtTo: '2025-01-31' }).success,
    ).toBe(true);
  });
});

describe('Курсор', () => {
  it('переживает кодирование и раскодирование', () => {
    const cursor = {
      value: '2025-01-31T12:00:00.000Z',
      id: '11111111-2222-3333-4444-555555555555',
    };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('не читается глазами: это деталь реализации, а не часть контракта', () => {
    const encoded = encodeCursor({
      value: '2025-01-31T12:00:00.000Z',
      id: 'x',
    });

    expect(encoded).not.toContain('2025');
  });

  it('на мусор отвечает null, а не падением', () => {
    expect(decodeCursor('не курсор')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    // Валидный base64, но внутри не курсор
    expect(
      decodeCursor(Buffer.from('{"a":1}').toString('base64url')),
    ).toBeNull();
  });
});
