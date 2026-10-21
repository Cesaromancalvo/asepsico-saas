import { ForbiddenException, Injectable } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { internalRecipients, isImplicitTlsPort, MailConfig, readMailConfig } from './mail.config';

/** Mensaje de texto plano. Sin HTML, sin imágenes remotas, sin seguimiento. */
export type InternalMail = { to: string; subject: string; text: string };

/** Interfaz del transporte: el servicio no depende del proveedor (hoy SMTP de Scaleway). */
export interface MailTransport {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<void>;
}

/** Longitud mínima de asunto y cuerpo (requisito de Scaleway Transactional Email). */
export const MIN_MAIL_PART_LENGTH = 10;

/**
 * Transporte SMTP con nodemailer (versión exacta fijada en package.json; sin dependencias
 * transitivas). TLS obligatorio: 465/2465 con TLS implícito, 587/2587 con STARTTLS exigido (requireTLS),
 * TLS 1.2 como mínimo, certificado verificado, AUTH PLAIN y sin acceso a ficheros ni URLs desde el
 * mensaje. Timeouts cortos: si la red bloquea el puerto (p. ej. Render gratuito con 465/587), el fallo
 * llega al log en segundos (solo tipo y código de error) en lugar de quedarse colgado.
 */
export function smtpTransport(config: NonNullable<MailConfig>): MailTransport {
  const transporter = createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: isImplicitTlsPort(config.smtp.port),
    requireTLS: true,
    auth: { user: config.smtp.user, pass: config.smtp.password },
    authMethod: 'PLAIN',
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  return {
    async send(message) {
      await transporter.sendMail({ ...message, disableFileAccess: true, disableUrlAccess: true });
    },
  };
}

/**
 * Correo saliente INTERNO de AsePsico (avisos al equipo; hoy solo el aviso de la lista de espera).
 *
 * FUERA DE ALCANCE Y BLOQUEADO: escribir a pacientes. Solo se envía a las direcciones internas de
 * WAITLIST_NOTIFY_TO; cualquier otro destinatario se rechaza (403) antes de tocar el transporte.
 * Un envío futuro a pacientes exige un servicio aparte que compruebe portalEmailUsableForDelivery
 * (correo verificado, src/portal/portal-email.util.ts) y revisión de Argos y Lex Psi.
 *
 * Sin configuración completa no se crea transporte y send() no hace nada (devuelve false).
 * Nunca registra destinatarios, asuntos ni cuerpos.
 */
@Injectable()
export class MailService {
  private readonly config: MailConfig;
  private readonly transport: MailTransport | null;
  private readonly allowed: Set<string>;

  constructor(env: NodeJS.ProcessEnv = process.env, transportFactory: (config: NonNullable<MailConfig>) => MailTransport = smtpTransport) {
    this.config = readMailConfig(env);
    this.transport = this.config ? transportFactory(this.config) : null;
    this.allowed = new Set(internalRecipients(env));
  }

  isConfigured(): boolean {
    return this.transport !== null;
  }

  /** Envía un aviso interno. false si no hay transporte configurado. Lanza si el envío falla. */
  async sendInternal(mail: InternalMail): Promise<boolean> {
    if (!this.allowed.has(mail.to.trim().toLowerCase())) {
      throw new ForbiddenException('Destinatario no permitido: el correo saliente solo admite avisos internos');
    }
    if (mail.subject.length < MIN_MAIL_PART_LENGTH || mail.text.length < MIN_MAIL_PART_LENGTH) {
      throw new Error('Asunto y cuerpo deben tener al menos 10 caracteres');
    }
    if (!this.transport || !this.config) return false;
    await this.transport.send({ from: this.config.from, to: mail.to, subject: mail.subject, text: mail.text });
    return true;
  }
}
