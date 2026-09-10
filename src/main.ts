import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.schema.js';

async function bootstrap() {
  // Создаём приложение: Nest читает метаданные @Module и собирает
  // граф зависимостей (какой провайдер кому нужен).
  const app = await NestFactory.create(AppModule);

  // Разбирает заголовок Cookie в объект request.cookies.
  // Без этой строки токены из cookies прочитать не получится.
  app.use(cookieParser());

  // Берём готовый ConfigService из контейнера — конфиг уже провалидирован zod.
  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });

  // Аккуратное завершение: Nest успеет закрыть пул соединений с Postgres,
  // когда процесс получит SIGTERM (например, docker stop).
  app.enableShutdownHooks();

  /**
   * Описание API на /api.
   *
   * Схемы тел и параметров не описаны декораторами вручную — они
   * переведены из тех же zod-схем, по которым запросы проверяются
   * (см. common/openapi/zod-openapi.ts). Один источник правды: правка в
   * схеме сразу видна в документации.
   *
   * Окно открытое: это учебный проект, и документация нужна раньше, чем
   * появится кто-то, от кого её стоило бы закрывать. В боевом приложении
   * его закрывают либо совсем, либо охранником.
   */
  const swagger = new DocumentBuilder()
    .setTitle('Course App API')
    .setDescription(
      'Аутентификация, RBAC, профиль, смена почты, удаление аккаунта, ' +
        'список пользователей. Токены передаются в httpOnly cookies, ' +
        'поэтому «Try it out» работает только из того же браузера, где вы вошли.',
    )
    .setVersion('1.0')
    // Оба токена лежат в cookies, а не в заголовке Authorization
    .addCookieAuth('access_token', { type: 'apiKey', in: 'cookie' })
    .build();

  SwaggerModule.setup('api', app, () =>
    SwaggerModule.createDocument(app, swagger),
  );

  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`Приложение слушает http://localhost:${port}`);
  logger.log(`Описание API: http://localhost:${port}/api`);
}

await bootstrap();
