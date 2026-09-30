import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Borrado garantizado del fichero temporal a las 24 horas (spec, apartado 7).
 *
 * Tres capas: (1) al confirmar o cancelar se borra en el acto; (2) cualquier acceso a un lote
 * caducado lo borra antes de responder 410 (PatientImportJobsService.loadPayload); (3) esta
 * limpieza periódica borra los que nadie volvió a tocar. Es una tarea de sistema (sin actor):
 * solo pone a null el payload caducado, no lee ni devuelve nada, y es idempotente, así que puede
 * correr en varias instancias a la vez.
 */
@Injectable()
export class PatientImportCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PatientImportCleanupService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.purgeExpired().catch((error) => this.logger.warn(`Limpieza de importaciones fallida (${(error as Error)?.name ?? 'Error'})`));
    }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async purgeExpired(now = new Date()) {
    const waiting = await this.prisma.patientImportJob.updateMany({
      where: { status: { in: ['UPLOADED', 'PREVIEWED'] }, payloadExpiresAt: { lte: now } },
      data: { status: 'EXPIRED', payload: null, payloadExpiresAt: null },
    });
    const others = await this.prisma.patientImportJob.updateMany({
      where: { payloadExpiresAt: { lte: now } },
      data: { payload: null, payloadExpiresAt: null },
    });
    // Por si acaso: ningún payload sin fecha de caducidad debe sobrevivir.
    const orphan = await this.prisma.patientImportJob.updateMany({
      where: { payload: { not: null }, payloadExpiresAt: null },
      data: { payload: null },
    });
    return { expired: waiting.count, purged: waiting.count + others.count + orphan.count };
  }
}
