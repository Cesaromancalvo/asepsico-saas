import { Injectable } from '@nestjs/common';
import { MailTransport, MIN_MAIL_PART_LENGTH, smtpTransport } from '../../mail/mail.service';
import { SmtpConfig } from '../../mail/mail.config';
import { EmailTemplateName, RenderedEmail, templateGroup } from './email-templates';
import { NotificationEmailConfig, readNotificationEmailConfig } from './notification-email.config';

export class EmailGroupDisabledError extends Error {}

/**
 * Envío de los avisos por email. Remitente ÚNICO para todo (MAIL_FROM, decisión del Jefe 07/11/2026):
 * no hay parámetro para elegir remitente. La plantilla decide el GRUPO (STAFF / PATIENT) y con él qué
 * interruptor tiene que estar encendido.
 *
 * Nunca registra destinatarios, asuntos ni cuerpos. Sin cabeceras propias (TEM convierte los
 * metadatos en cabeceras visibles): solo from, to, subject, text y html.
 */
@Injectable()
export class NotificationMailer {
  readonly config: NotificationEmailConfig;
  private readonly transport: MailTransport | null;

  constructor(env: NodeJS.ProcessEnv = process.env, transportFactory: (config: { smtp: SmtpConfig }) => MailTransport = smtpTransport) {
    this.config = readNotificationEmailConfig(env);
    this.transport = this.config.smtp ? transportFactory({ smtp: this.config.smtp }) : null;
  }

  async send(template: EmailTemplateName, to: string, email: RenderedEmail): Promise<{ providerRef: string | null }> {
    const group = templateGroup(template);
    if (!this.transport) throw new EmailGroupDisabledError('Sin transporte de correo');
    if (group === 'STAFF' ? !this.config.staff.enabled : !this.config.patient.enabled) throw new EmailGroupDisabledError(`Grupo ${group} apagado`);
    if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(to)) throw new Error('INVALID_RECIPIENT');
    if (email.subject.length < MIN_MAIL_PART_LENGTH || email.text.length < MIN_MAIL_PART_LENGTH) throw new Error('Asunto y cuerpo deben tener al menos 10 caracteres');
    if (/[\r\n]/.test(email.subject)) throw new Error('Asunto no válido');
    const from = this.config.from;
    if (!from) throw new EmailGroupDisabledError('Remitente no configurado');
    const result = await this.transport.send({ from, to, subject: email.subject, text: email.text, html: email.html });
    return { providerRef: (result && result.messageId) || null };
  }
}
