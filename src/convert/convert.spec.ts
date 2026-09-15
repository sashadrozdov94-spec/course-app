import { CONVERTERS, findConverter } from './converters/index.js';
import { FileFormat } from './format.js';
import { detectFormat } from './format-detector.js';

/** Короткая запись «сконвертируй вот это вот туда». */
function convert(source: string, target: string, input: string): string {
  const converter = findConverter(source, target);

  if (!converter) {
    throw new Error(`нет направления ${source} → ${target}`);
  }

  return converter.convert(input);
}

describe('Набор направлений', () => {
  it('покрывает все 12 пар из ТЗ и не содержит лишних', () => {
    const directions = CONVERTERS.map((c) => `${c.source}→${c.target}`).sort();

    expect(directions).toEqual(
      [
        'csv→json',
        'csv→xml',
        'csv→yaml',
        'json→csv',
        'json→xml',
        'json→yaml',
        'xml→csv',
        'xml→json',
        'xml→yaml',
        'yaml→csv',
        'yaml→json',
        'yaml→xml',
      ].sort(),
    );
  });

  it('не предлагает конвертацию формата в самого себя', () => {
    expect(findConverter('json', 'json')).toBeUndefined();
  });
});

describe('CSV → другие форматы', () => {
  const csv = 'name,age\r\nAlice,30\r\nBob,25\r\n';

  it('CSV → JSON даёт массив объектов, значения остаются строками', () => {
    expect(JSON.parse(convert('csv', 'json', csv))).toEqual([
      { name: 'Alice', age: '30' },
      { name: 'Bob', age: '25' },
    ]);
  });

  it('CSV → XML заворачивает строки в <item> внутри <root>', () => {
    const xml = convert('csv', 'xml', csv);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<root>');
    expect(xml.match(/<item>/g)).toHaveLength(2);
    expect(xml).toContain('<name>Alice</name>');
  });

  it('CSV → YAML даёт список отображений', () => {
    expect(convert('csv', 'yaml', csv)).toBe(
      '- name: Alice\n  age: "30"\n- name: Bob\n  age: "25"\n',
    );
  });
});

describe('JSON → другие форматы', () => {
  it('JSON → CSV разворачивает массив объектов в таблицу', () => {
    const json = '[{"name":"Alice","age":30},{"name":"Bob","age":25}]';

    expect(convert('json', 'csv', json)).toBe(
      'name,age\r\nAlice,30\r\nBob,25\r\n',
    );
  });

  it('JSON → CSV снимает обёртку с единственным ключом', () => {
    const json = '{"users":[{"id":1},{"id":2}]}';

    expect(convert('json', 'csv', json)).toBe('id\r\n1\r\n2\r\n');
  });

  it('JSON → CSV разворачивает вложенность в колонки через точку', () => {
    const json = '[{"user":{"name":"Alice"},"tags":["a","b"]}]';

    expect(convert('json', 'csv', json)).toBe(
      'user.name,tags.0,tags.1\r\nAlice,a,b\r\n',
    );
  });

  it('JSON → CSV объединяет колонки разных строк', () => {
    const json = '[{"a":1},{"b":2}]';

    expect(convert('json', 'csv', json)).toBe('a,b\r\n1,\r\n,2\r\n');
  });

  it('JSON → CSV экранирует запятые, кавычки и переводы строк', () => {
    const json = '[{"note":"Иванов, Иван"},{"note":"он сказал \\"да\\""}]';

    expect(convert('json', 'csv', json)).toBe(
      'note\r\n"Иванов, Иван"\r\n"он сказал ""да"""\r\n',
    );
  });

  it('JSON → CSV отказывается собирать таблицу без строк', () => {
    expect(() => convert('json', 'csv', '[]')).toThrow(/Нет ни одной строки/);
  });

  it('JSON → XML берёт единственный ключ верхнего уровня как корень', () => {
    const xml = convert('json', 'xml', '{"note":{"body":"привет"}}');

    expect(xml).toContain('<note>');
    expect(xml).toContain('<body>привет</body>');
  });

  it('JSON → XML называет корень <root>, если своего имени нет', () => {
    expect(convert('json', 'xml', '{"a":1,"b":2}')).toContain('<root>');
  });

  it('JSON → XML кладёт ключи с @ в атрибуты', () => {
    expect(convert('json', 'xml', '{"@id":"7","name":"Alice"}')).toContain(
      '<root id="7">',
    );
  });

  it('JSON → XML отказывает, если ключ не годится в имя элемента', () => {
    expect(() => convert('json', 'xml', '{"имя файла":1,"b":2}')).toThrow(
      /нельзя записать как элемент XML/,
    );
  });

  it('JSON → YAML пишет числа числами', () => {
    expect(convert('json', 'yaml', '{"age":30,"ok":true}')).toBe(
      'age: 30\nok: true\n',
    );
  });

  it('не принимает синтаксически неверный JSON', () => {
    expect(() => convert('json', 'yaml', '{"a":}')).toThrow(
      /Некорректный JSON/,
    );
  });
});

describe('XML → другие форматы', () => {
  const xml = '<catalog><book id="1"><title>Дюна</title></book></catalog>';

  it('XML → JSON: атрибуты получают префикс @, типы не угадываются', () => {
    expect(JSON.parse(convert('xml', 'json', xml))).toEqual({
      catalog: { book: { '@id': '1', title: 'Дюна' } },
    });
  });

  it('XML → JSON: повторяющиеся теги становятся массивом', () => {
    const repeated = '<root><a>1</a><a>2</a></root>';

    expect(JSON.parse(convert('xml', 'json', repeated))).toEqual({
      root: { a: ['1', '2'] },
    });
  });

  it('XML → CSV снимает обёртки и собирает таблицу', () => {
    const rows =
      '<root><row><id>1</id><name>Alice</name></row>' +
      '<row><id>2</id><name>Bob</name></row></root>';

    expect(convert('xml', 'csv', rows)).toBe('id,name\r\n1,Alice\r\n2,Bob\r\n');
  });

  it('XML → YAML сохраняет структуру', () => {
    expect(convert('xml', 'yaml', xml)).toBe(
      'catalog:\n  book:\n    title: Дюна\n    "@id": "1"\n',
    );
  });

  it('не принимает документ с DOCTYPE: запрет внешних сущностей', () => {
    const xxe =
      '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<root>&xxe;</root>';

    expect(() => convert('xml', 'json', xxe)).toThrow(/DOCTYPE/);
  });

  it('не принимает синтаксически неверный XML', () => {
    expect(() => convert('xml', 'json', '<a><b></a>')).toThrow(
      /Некорректный XML/,
    );
  });
});

describe('YAML → другие форматы', () => {
  it('YAML → JSON читает вложенность и типы', () => {
    const yaml = 'users:\n  - name: Alice\n    age: 30\n';

    expect(JSON.parse(convert('yaml', 'json', yaml))).toEqual({
      users: [{ name: 'Alice', age: 30 }],
    });
  });

  it('YAML 1.2: no и yes остаются строками, а не логическими', () => {
    expect(
      JSON.parse(convert('yaml', 'json', 'country: no\nanswer: yes\n')),
    ).toEqual({ country: 'no', answer: 'yes' });
  });

  it('YAML → CSV разворачивает список отображений в таблицу', () => {
    const yaml = '- id: 1\n  name: Alice\n- id: 2\n  name: Bob\n';

    expect(convert('yaml', 'csv', yaml)).toBe(
      'id,name\r\n1,Alice\r\n2,Bob\r\n',
    );
  });

  it('YAML → XML собирает документ с корнем из единственного ключа', () => {
    const xml = convert('yaml', 'xml', 'note:\n  body: привет\n');

    expect(xml).toContain('<note>');
    expect(xml).toContain('<body>привет</body>');
  });

  it('не принимает документ из одних комментариев', () => {
    expect(() => convert('yaml', 'json', '# только комментарий\n')).toThrow(
      /не содержит данных/,
    );
  });

  it('не принимает повторяющиеся ключи', () => {
    expect(() => convert('yaml', 'json', 'a: 1\na: 2\n')).toThrow(
      /Некорректный YAML/,
    );
  });

  it('обрывает раскрытие ссылок: защита от YAML-бомбы', () => {
    const bomb =
      'a: &a [x,x,x,x,x,x,x,x,x,x]\n' +
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\n' +
      'c: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\n';

    expect(() => convert('yaml', 'json', bomb)).toThrow(
      /не удалось развернуть/,
    );
  });
});

describe('Разбор CSV по RFC 4180', () => {
  it('читает поля в кавычках с запятыми и переводами строк', () => {
    const csv = 'note,who\r\n"Иванов, Иван","строка\nвторая"\r\n';

    expect(JSON.parse(convert('csv', 'json', csv))).toEqual([
      { note: 'Иванов, Иван', who: 'строка\nвторая' },
    ]);
  });

  it('читает удвоенную кавычку как одну', () => {
    const csv = 'note\r\n"он сказал ""да"""\r\n';

    expect(JSON.parse(convert('csv', 'json', csv))).toEqual([
      { note: 'он сказал "да"' },
    ]);
  });

  it('читает файл с переводами строк LF, а не только CRLF', () => {
    expect(JSON.parse(convert('csv', 'json', 'a,b\n1,2\n'))).toEqual([
      { a: '1', b: '2' },
    ]);
  });

  it('даёт пустым заголовкам имя по номеру колонки', () => {
    expect(JSON.parse(convert('csv', 'json', 'a,,c\r\n1,2,3\r\n'))).toEqual([
      { a: '1', column2: '2', c: '3' },
    ]);
  });

  it('отказывается от повторяющихся заголовков', () => {
    expect(() => convert('csv', 'json', 'a,a\r\n1,2\r\n')).toThrow(
      /встречается в заголовке дважды/,
    );
  });

  it('отказывается от строк с другим числом полей', () => {
    expect(() => convert('csv', 'json', 'a,b\r\n1,2,3\r\n')).toThrow(
      /в заголовке 2/,
    );
  });

  it('отказывается от незакрытой кавычки', () => {
    expect(() => convert('csv', 'json', 'a,b\r\n"незакрытое,2\r\n')).toThrow(
      /Незакрытая кавычка/,
    );
  });
});

describe('Проходы туда и обратно', () => {
  it('csv → json → csv возвращает исходную таблицу', () => {
    const csv = 'name,age\r\nAlice,30\r\nBob,25\r\n';

    expect(convert('json', 'csv', convert('csv', 'json', csv))).toBe(csv);
  });

  it('xml → json → xml возвращает исходную разметку', () => {
    const xml = convert('json', 'xml', '{"note":{"body":"привет"}}');

    expect(convert('json', 'xml', convert('xml', 'json', xml))).toBe(xml);
  });

  it('json → yaml → json сохраняет данные и типы', () => {
    const json = '{"a":1,"b":[true,null,"текст"]}';

    expect(
      JSON.parse(convert('yaml', 'json', convert('json', 'yaml', json))),
    ).toEqual(JSON.parse(json));
  });
});

describe('Ограничения структуры', () => {
  it('отказывается от слишком глубокой вложенности', () => {
    const deep = `${'['.repeat(200)}1${']'.repeat(200)}`;

    expect(() => convert('json', 'yaml', deep)).toThrow(/глубокая структура/);
  });
});

describe('Определение формата', () => {
  it('узнаёт XML по угловой скобке', () => {
    expect(detectFormat('<root/>')).toBe(FileFormat.Xml);
    expect(detectFormat('<?xml version="1.0"?><a/>')).toBe(FileFormat.Xml);
  });

  it('узнаёт JSON по объекту, массиву и скаляру', () => {
    expect(detectFormat('{"a":1}')).toBe(FileFormat.Json);
    expect(detectFormat('[1,2]')).toBe(FileFormat.Json);
    expect(detectFormat('"строка"')).toBe(FileFormat.Json);
  });

  it('узнаёт YAML по началу документа и по строке «ключ: значение»', () => {
    expect(detectFormat('---\na: 1\n')).toBe(FileFormat.Yaml);
    expect(detectFormat('name: Alice\nage: 30\n')).toBe(FileFormat.Yaml);
    expect(detectFormat('- 1\n- 2\n')).toBe(FileFormat.Yaml);
  });

  it('узнаёт CSV по одинаковому числу полей в строках', () => {
    expect(detectFormat('name,age\r\nAlice,30\r\n')).toBe(FileFormat.Csv);
  });

  it('не путает запятую внутри кавычек с разделителем', () => {
    expect(detectFormat('note\r\n"Иванов, Иван"\r\n')).not.toBe(FileFormat.Csv);
  });

  it('содержимое важнее расширения', () => {
    expect(detectFormat('<root/>', FileFormat.Json)).toBe(FileFormat.Xml);
  });

  it('расширение решает там, где содержимое неоднозначно', () => {
    // Одна колонка без запятых — это и корректный CSV, и корректный YAML
    expect(detectFormat('name\r\nAlice\r\n', FileFormat.Csv)).toBe(
      FileFormat.Csv,
    );
    expect(detectFormat('{a: 1}', FileFormat.Yaml)).toBe(FileFormat.Yaml);
  });

  it('ничего не выдумывает, когда подсказок нет', () => {
    expect(detectFormat('просто текст')).toBeNull();
  });
});
