/**
 * Форматы, которые приложение умеет читать и писать.
 *
 * Перечисление — единственное место, где формат объявляется. Добавится
 * новый формат — он появится здесь, и дальше нужен только один класс
 * кодека (codecs/): ни контроллер, ни сервис, ни схемы менять не придётся,
 * а все направления в обе стороны соберутся сами.
 */
export enum FileFormat {
  Csv = 'csv',
  Json = 'json',
  Xml = 'xml',
  Yaml = 'yaml',
}

/**
 * Расширение файла → формат. Для определения формата по имени.
 *
 * У YAML исторически два расширения, и оба встречаются одинаково часто,
 * поэтому обрабатываем оба.
 */
export const FORMAT_BY_EXTENSION: Readonly<Record<string, FileFormat>> = {
  csv: FileFormat.Csv,
  json: FileFormat.Json,
  xml: FileFormat.Xml,
  yaml: FileFormat.Yaml,
  yml: FileFormat.Yaml,
};

/**
 * Что отдавать в Content-Type результата.
 *
 * Для YAML это application/yaml из RFC 9512: до 2024 года
 * общепринятого типа не было, и в старых примерах встречается
 * text/yaml или application/x-yaml.
 */
export const MIME_BY_FORMAT: Readonly<Record<FileFormat, string>> = {
  [FileFormat.Csv]: 'text/csv; charset=utf-8',
  [FileFormat.Json]: 'application/json; charset=utf-8',
  [FileFormat.Xml]: 'application/xml; charset=utf-8',
  [FileFormat.Yaml]: 'application/yaml; charset=utf-8',
};
