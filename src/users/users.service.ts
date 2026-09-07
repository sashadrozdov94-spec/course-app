import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserStatus } from './entities/user.entity.js';

// Всё общение с таблицей users идёт через этот сервис.
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  // Есть ли уже такой пользователь. Возвращает null, если нет.
  findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  // Отпечаток пароля скрыт от обычных выборок, поэтому просим его отдельно.
  findByEmailWithPassword(email: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
        emailVerifiedAt: true,
      },
    });
  }

  // Найти по номеру. null, если такого пользователя нет.
  findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  /**
   * Найти по номеру вместе с ролями.
   *
   * Отдельным методом, а не «всегда с ролями»: связка стоит лишнего JOIN,
   * и большинству мест роли не нужны. Нужны они охраннику JwtAuthGuard —
   * он кладёт пользователя в запрос, а из запроса его берёт проверка прав.
   */
  findByIdWithRoles(id: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { id },
      relations: { roles: true },
    });
  }

  // Найти по номеру. Бросает ошибку, если такого нет.
  async findByIdOrFail(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    return user;
  }

  // Почта подтверждена: ставим дату и делаем аккаунт рабочим.
  async markEmailVerified(id: string): Promise<User> {
    await this.usersRepository.update(
      { id },
      { emailVerifiedAt: new Date(), status: UserStatus.Active },
    );

    return this.findByIdOrFail(id);
  }

  // Создаёт пользователя. Пароль сюда приходит уже в виде отпечатка.
  create(data: {
    email: string;
    passwordHash: string;
    status: UserStatus;
    emailVerifiedAt: Date | null;
  }): Promise<User> {
    const user = this.usersRepository.create(data);
    return this.usersRepository.save(user);
  }
}
