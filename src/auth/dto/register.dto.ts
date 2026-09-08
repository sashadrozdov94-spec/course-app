import * as z from 'zod';

// Правила для данных, которые присылает клиент при регистрации.
export const registerSchema = z.object({
  email: z
    .string({ error: 'Укажите адрес почты' })
    .trim() // убрать пробелы по краям
    .toLowerCase() // Bob@Mail.com и bob@mail.com — это один человек
    .pipe(z.email('Введите настоящий адрес почты'))
    .refine((value) => value.length <= 320, 'Слишком длинный адрес'),

  password: z
    .string({ error: 'Укажите пароль' })
    .min(8, 'Пароль должен быть не короче 8 символов')
    .max(64, 'Пароль должен быть не длиннее 64 символов')
    .refine(
      (value) => /[a-zA-Zа-яА-Я]/.test(value),
      'В пароле нужна хотя бы одна буква',
    )
    .refine(
      (value) => /[0-9]/.test(value),
      'В пароле нужна хотя бы одна цифра',
    ),
});

// Тип данных после проверки — делается из схемы сам.
export type RegisterDto = z.infer<typeof registerSchema>;
