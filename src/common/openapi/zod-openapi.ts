import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import * as z from 'zod';

/**
 * Тип схемы OpenAPI, вынутый из сигнатуры самого декоратора.
 *
 * Импортировать его напрямую нельзя: @nestjs/swagger разрешает в exports
 * только корень пакета, а SchemaObject лежит глубже. Брать тип из
 * Parameters<> надёжнее ещё и потому, что он не разъедется с версией
 * пакета — это ровно то, что декоратор и принимает.
 */
type OpenApiSchema = Extract<
  Parameters<typeof ApiBody>[0],
  { schema: unknown }
>['schema'];

/**
 * Настройки перевода zod-схемы в схему OpenAPI.
 *
 * io: 'input'        — описываем то, что клиент ПРИСЫЛАЕТ. Для z.coerce и
 *                      .default() вход и выход различаются: limit приходит
 *                      строкой, а на выходе уже число.
 * target             — Swagger UI ожидает диалект OpenAPI 3.0, а не
 *                      «чистый» JSON Schema.
 * unrepresentable    — .refine() и .transform() в JSON Schema выразить
 *                      нельзя. 'any' велит пропустить их, а не падать:
 *                      проверка всё равно останется в пайпе, просто в
 *                      документацию не попадёт.
 */
const OPTIONS = {
  io: 'input',
  target: 'openapi-3.0',
  unrepresentable: 'any',
} as const;

/**
 * Схема OpenAPI из zod-схемы.
 *
 * Единственный источник правды остаётся один — сама zod-схема, по которой
 * пайп проверяет запрос. Описывать поля второй раз декораторами
 * @ApiProperty() значило бы гарантированно их рассинхронизировать: правку
 * внесли в одном месте, забыли в другом.
 */
export function zodToOpenApi(schema: z.ZodType): OpenApiSchema {
  return z.toJSONSchema(schema, OPTIONS) as OpenApiSchema;
}

/** Тело запроса из zod-схемы. */
export function ApiZodBody(schema: z.ZodType, description?: string) {
  return ApiBody({ schema: zodToOpenApi(schema), description });
}

/**
 * Параметры строки запроса из zod-схемы.
 *
 * Swagger описывает их по одному, а не объектом целиком, поэтому
 * раскладываем свойства схемы на отдельные декораторы.
 */
export function ApiZodQuery(schema: z.ZodObject) {
  // Наш конвертер всегда отдаёт схему объекта, а не ссылку на неё, поэтому
  // из объединения SchemaObject | ReferenceObject берём первый вариант.
  const converted = zodToOpenApi(schema) as Extract<
    OpenApiSchema,
    { properties?: unknown }
  >;
  const properties = converted.properties ?? {};
  const required = new Set(converted.required ?? []);

  return applyDecorators(
    ...Object.entries(properties).map(([name, property]) =>
      ApiQuery({
        name,
        required: required.has(name),
        schema: property as OpenApiSchema,
      }),
    ),
  );
}
