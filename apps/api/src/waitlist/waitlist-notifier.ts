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
      this.schedule(wait, false);
    } catch (error) {
      this.logger.warn(`Aviso de lista de espera no programado (${(error as Error)?.name ?? 'Error'})`);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number, isRetry: boolean, carried = 0) {
    this.timer = setTimeout(() => void this.flush(isRetry, carried), ms);
    this.timer.unref();
  }

  /** Envía el aviso acumulado. Público para los tests. */
  async flush(isRetry = false, carried = 0): Promise<void> {
    this.timer = undefined;
    // Las altas que llegaron mientras esperaba el reintento se suman a las arrastradas.
    const count = carried + this.pending;
    this.pending = 0;
    if (count <= 0) return;
    this.lastSentAt = Date.now();
    try {
      const total = await this.prisma.waitlistEntry.count({ where: { deletedAt: null } });
      const text = waitlistNotifyBody(count, total, new Date());
      for (const to of internalRecipients(this.env)) {
        await this.mail.sendInternal({ to, subject: WAITLIST_NOTIFY_SUBJECT, text });
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      this.logger.warn(`Aviso de lista de espera no enviado (${(error as Error)?.name ?? 'Error'}${code ? ` ${code}` : ''})${isRetry ? '' : '; se reintenta una vez'}`);
      if (!isRetry) {
        this.schedule(WAITLIST_NOTIFY_RETRY_MS, true, count);
      }
    }
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
