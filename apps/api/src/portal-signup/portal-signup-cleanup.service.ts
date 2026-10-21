import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SignupRequestsService } from './signup-requests.service';

/** Primera purga unos segundos después de arrancar (sin bloquear el arranque). */
export const SIGNUP_CLEANUP_STARTUP_DELAY_MS = 10_000;
/** Después, cada hora. */
export const SIGNUP_CLEANUP_INTERVAL_MS = 60 * 60_000;

/**
 * Purga automática de las solicitudes de alta por QR caducadas (14 días), en todos los espacios.
 * Mismo patrón que PatientImportCleanupService: tarea de sistema sin actor, idempotente (puede
 * correr en varias instancias a la vez), temporizadores con unref() para no retener el proceso y
 * nada en los tests. Un fallo solo deja un aviso con el tipo de error, nunca datos.
 * `npm run portal-signup:purge` queda como respaldo manual (ops/PILOT_RUNBOOK.md).
 */
@Injectable()
export class PortalSignupCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PortalSignupCleanupService.name);
  private startupTimer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;

  constructor(private readonly requests: SignupRequestsService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.startupTimer = setTimeout(() => void this.runOnce(), SIGNUP_CLEANUP_STARTUP_DELAY_MS);
    this.startupTimer.unref();
    this.interval = setInterval(() => void this.runOnce(), SIGNUP_CLEANUP_INTERVAL_MS);
    this.interval.unref();
  }

  onModuleDestroy() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.interval) clearInterval(this.interval);
  }

  /** Nunca lanza: el temporizador no debe tumbar el proceso. */
  async runOnce(): Promise<void> {
    try {
      await this.requests.purgeExpired();
    } catch (error) {
      this.logger.warn(`Purga de solicitudes de alta fallida (${(error as Error)?.name ?? 'Error'})`);
    }
  }
}
