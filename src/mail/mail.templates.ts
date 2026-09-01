import type { Letter } from './mail.service.js';

// Текст писем держим отдельно от логики отправки.

export function otpLetter(to: string, code: string, ttlMinutes: number): Letter {
  return {
    to,
    subject: `Код подтверждения: ${code}`,
    text: `Ваш код подтверждения: ${code}\n\nКод действует ${ttlMinutes} минут. Если вы не регистрировались — просто проигнорируйте это письмо.`,
    html: `<p>Ваш код подтверждения:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
<p>Код действует ${ttlMinutes} минут. Если вы не регистрировались — просто проигнорируйте это письмо.</p>`,
  };
}

export function magicLinkLetter(
  to: string,
  link: string,
  ttlMinutes: number,
): Letter {
  return {
    to,
    subject: 'Подтвердите адрес почты',
    text: `Чтобы подтвердить адрес почты, откройте ссылку:\n${link}\n\nСсылка действует ${ttlMinutes} минут и срабатывает один раз.`,
    html: `<p>Чтобы подтвердить адрес почты, нажмите на ссылку:</p>
<p><a href="${link}">Подтвердить почту</a></p>
<p>Ссылка действует ${ttlMinutes} минут и срабатывает один раз.</p>`,
  };
}
