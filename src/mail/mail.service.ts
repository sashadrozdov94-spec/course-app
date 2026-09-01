import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../config/env.schema.js';

export interface Letter {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Отправка писем.
 *
 * Два режима (MAIL_DRIVER в .env):
 *   console — письмо печатается в консоль. Удобно, пока нет доступов к turboSMTP.
 *   smtp    — письмо реально уходит через turboSMTP.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  // Nest вызывает это один раз при запуске приложения.
  onModuleInit(): void {
    if (this.config.get('MAIL_DRIVER', { infer: true }) !== 'smtp') {
      this.logger.warn('MAIL_DRIVER=console: письма печатаются в консоль');
      return;
    }

    this.transporter = createTransport({
      host: this.config.get('SMTP_HOST', { infer: true }),
      port: this.config.get('SMTP_PORT', { infer: true }),
      // secure: true нужен только для порта 465. На 587 идёт STARTTLS.
      secure: this.config.get('SMTP_PORT', { infer: true }) === 465,
      auth: {
        user: this.config.get('SMTP_USER', { infer: true }),
        pass: this.config.get('SMTP_PASSWORD', { infer: true }),
      },
    });
  }

  async send(letter: Letter): Promise<void> {
    // Режим console: просто печатаем письмо целиком.
    if (!this.transporter) {
      this.logger.log(
        [
          '',
          '───────── ПИСЬМО (не отправлено, режим console) ─────────',
          `Кому:  ${letter.to}`,
          `Тема:  ${letter.subject}`,
          '',
          letter.text,
          '─────────────────────────────────────────────────────────',
        ].join('\n'),
      );
      return;
    }

    await this.transporter.sendMail({
      from: this.config.get('MAIL_FROM', { infer: true }),
      to: letter.to,
      subject: letter.subject,
      text: letter.text,
      html: letter.html,
    });

    this.logger.log(`Письмо отправлено на ${letter.to}`);
  }
}
