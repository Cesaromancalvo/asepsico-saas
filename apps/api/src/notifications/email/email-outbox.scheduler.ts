import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { EmailOutboxService } from './email-outbox.service';

export const EMAIL_OUTBOX_INTERVAL_MS = 5 * 60_000;

/**
 * Tarea programada DENTRO de la API (decisión D3: Render de pago, siempre despierta): una pasada de
 * la bandeja de salida cada 5 minutos. Sin dependencias nuevas (setInterval con unref).
 *
 * No arranca con NODE_ENV=test ni con EMAIL_OUTBOX_SCHEDULER=off (p. ej. una réplica de solo
 * lectura). Aunque arranque, con los interruptores apagados solo caduca entregas viejas: no envía.
 * Varias instancias a la vez son seguras: la reserva de entregas es atómica (SKIP LOCKED).
 */
@Injectable()
export class EmailOutboxScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('EmailOutboxScheduler');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly outbox: EmailOutboxService) {}

  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test' || (process.env.EMAIL_OUTBOX_SCHEDULER ?? '').trim().toLowerCase() === 'off') return;
    this.timer = setInterval(() => void this.tick(), EMAIL_OUTBOX_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    try {
      await this.outbox.processPass(new Date());
    } catch (error) {
      this.logger.error(`Pasada de la bandeja de salida fallida: ${(error as Error)?.name ?? 'Error'}`);
    }
  }
}
