import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity.js';
import { UsersService } from './users.service.js';

@Module({
  // forFeature — «дай мне кладовщика именно для таблицы users»
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService],
  // exports — разрешаем другим коробкам пользоваться UsersService
  exports: [UsersService],
})
export class UsersModule {}
