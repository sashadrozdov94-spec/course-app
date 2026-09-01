import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.schema.js';

async function bootstrap() {
  // Создаём приложение: Nest читает метаданные @Module и собирает
  // граф зависимостей (какой провайдер кому нужен).
  const app = await NestFactory.create(AppModule);

  // Берём готовый ConfigService из контейнера — конфиг уже провалидирован zod.
  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });

  // Аккуратное завершение: Nest успеет закрыть пул соединений с Postgres,
  // когда процесс получит SIGTERM (например, docker stop).
  app.enableShutdownHooks();

  await app.listen(port);

  new Logger('Bootstrap').log(`Приложение слушает http://localhost:${port}`);
}

await bootstrap();
