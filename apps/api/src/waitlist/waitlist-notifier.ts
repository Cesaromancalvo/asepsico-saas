import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { MailService } from '../mail/mail.service';
import { internalRecipients, waitlistNotifyEnabled } from '../mail/mail.config';

/** Como mucho un aviso cada 10 minutos; las altas de esa ventana se acumulan en el siguiente. */
export const WAITLIST_NOTIFY_WINDOW_MS = 10 * 60_000;
/** Un único reintento, pasado este tiempo. */
export const WAITLIST_NOTIFY_RETRY_MS = 60_000;
export const WAITLIST_NOTIFY_SUBJECT = 'Nuevo apunte en la lista de espera';

/**
 * Aviso por correo al Jefe cuando alguien se apunta a la lista de espera.
 *
 *  - Sin datos personales del apuntado: ni nombre, ni email, ni respuestas. Solo cuántas altas
 *    nuevas hay, el total activo, la fecha y cómo consultarlas (CLI waitlist:export).
 *  - Asíncrono: notifyNewEntry() solo apunta y programa; nunca bloquea ni hace fallar el alta.
 *  - Agrupado en memoria: como mucho 1 aviso por ventana de 10 min con el recuento acumulado.
 *    En el plan gratuito la API se duerme: un aviso pendiente puede perderse al dormir (aceptado;
 *    las altas siguen en la base de datos).
 *  - Fallo de envío: 1 reintento como mucho; después solo logger.warn con el tipo de error.
 *  - Apagado por defecto (WAITLIST_NOTIFY_ENABLED distinto de "true") o sin transporte: no hace nada.
 */
@Injectable()
export class WaitlistNotifier implements OnModuleDestroy {
  private readonly logger = new Logger('WaitlistNotifier');
  private pending = 0;
  private lastSentAt = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private enabled(): boolean {
    return waitlistNotifyEnabled(this.env) && this.mail.isConfigured() && internalRecipients(this.env).length > 0;
  }

  /** Llamar tras guardar un alta nueva. No lanza nunca. */
  notifyNewEntry(): void {
    try {
      if (!this.enabled()) return;
      this.pending += 1;
      if (this.timer) return; // ya hay un aviso programado: se acumula
      const wait = Math.max(0, this.lastSentAt + WAITLIST_NOTIFY_WINDOW_MS - Date.now());
      this.schedule(wait);
    } catch (error) {
      this.logger.warn(`Aviso de lista de espera no programado (${(error as Error)?.name ?? 'Error'})`);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number, retry?: { count: number; to: string[] }) {
    this.timer = setTimeout(() => void this.flush(retry), ms);
    this.timer.unref();
  }

  /**
   * Envía el aviso acumulado (o, con `retry`, reintenta UNA vez el mismo aviso solo a los
   * destinatarios que fallaron). Las altas que lleguen mientras tanto esperan al siguiente aviso
   * normal de la ventana. Público para los tests; nunca lanza.
   */
  async flush(retry?: { count: number; to: string[] }): Promise<void> {
    this.timer = undefined;
    const count = retry ? retry.count : this.pending;
    if (!retry) this.pending = 0;
    const recipients = retry ? retry.to : internalRecipients(this.env);
    if (count > 0 && recipients.length) {
      this.lastSentAt = Date.now();
      let failed: string[] = recipients;
      let lastError: unknown;
      try {
        const total = await this.prisma.waitlistEntry.count({ where: { deletedAt: null } });
        const text = waitlistNotifyBody(count, total, new Date());
        failed = [];
        for (const to of recipients) {
          try {
            await this.mail.sendInternal({ to, subject: WAITLIST_NOTIFY_SUBJECT, text });
          } catch (error) {
            failed.push(to);
            lastError = error;
          }
        }
      } catch (error) {
        lastError = error;
      }
      if (failed.length) {
        const code = (lastError as { code?: string })?.code;
        // Solo tipo y código de error: nunca destinatarios ni contenido.
        this.logger.warn(`Aviso de lista de espera no enviado (${(lastError as Error)?.name ?? 'Error'}${code ? ` ${code}` : ''})${retry ? '' : '; se reintenta una vez'}`);
        if (!retry) {
          this.schedule(WAITLIST_NOTIFY_RETRY_MS, { count, to: failed });
          return;
        }
      }
    }
    // Altas llegadas durante un reintento: siguiente aviso al cerrarse la ventana.
    if (!this.timer && this.pending > 0) {
      this.schedule(Math.max(0, this.lastSentAt + WAITLIST_NOTIFY_WINDOW_MS - Date.now()));
    }
  }

  /** Para los tests: altas acumuladas sin avisar todavía. */
  pendingCount(): number {
    return this.pending;
  }
}

/** Cuerpo del aviso: sin datos de nadie. */
export function waitlistNotifyBody(count: number, total: number, now: Date): string {
  const when = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' }).format(now);
  const nuevas = count === 1 ? 'Hay 1 alta nueva' : `Hay ${count} altas nuevas`;
  return [
    `${nuevas} en la lista de espera de AsePsico.`,
    `Total activas: ${total}`,
    `Fecha: ${when} (hora de Madrid)`,
    '',
    'Para consultarlas, desde el clon de despliegue: npm run waitlist:export (ver ops/PILOT_RUNBOOK.md).',
    'Este aviso no incluye datos de las personas apuntadas.',
  ].join('\n');
}
