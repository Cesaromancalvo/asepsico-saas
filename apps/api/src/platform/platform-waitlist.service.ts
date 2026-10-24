import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { compare } from 'bcryptjs';
import { fail, reject, RESET_FAILURES } from '../auth/mfa-attempt';
import { MfaActor, MfaService } from '../auth/mfa.service';
import { PrismaService } from '../database/prisma.service';
import { suppressWaitlistEntryById } from '../waitlist/waitlist-admin';
import { PLATFORM_AUDIT_ACTIONS, writePlatformAudit } from './platform-audit';
import { PLATFORM_WAITLIST_SELECT, PlatformWaitlistResponse, WaitlistRow, buildWaitlistResponse } from './platform-waitlist.view';

/** Solo ids con forma de cuid: cualquier otra cosa es un 404 sin tocar la BD. */
const ENTRY_ID = /^[a-z0-9]{20,40}$/;

/**
 * Panel privado de la lista de espera (solo PLATFORM_ADMIN, ver PlatformAdminGuard).
 * WaitlistEntry no tiene workspaceId: ninguna consulta de aquí lee ni escribe tablas de un
 * workspace. La auditoría va a PlatformAuditLog en la MISMA transacción que la operación.
 * Los logs solo llevan el tipo de evento: nunca nombre, email, herramientas ni ids de fila.
 */
@Injectable()
export class PlatformWaitlistService {
  private readonly logger = new Logger('PlatformWaitlist');

  constructor(private readonly prisma: PrismaService, private readonly mfa: MfaService) {}

  async list(actorId: string, now: Date = new Date()): Promise<PlatformWaitlistResponse> {
    return this.prisma.$transaction(async (tx) => {
      const rows = (await tx.waitlistEntry.findMany({
        where: { deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: PLATFORM_WAITLIST_SELECT,
      })) as WaitlistRow[];
      const response = buildWaitlistResponse(rows, now);
      await writePlatformAudit(tx, {
        actorId,
        action: PLATFORM_AUDIT_ACTIONS.WAITLIST_VIEWED,
        entityType: 'WaitlistEntry',
        metadata: { activeCount: response.counters.totalActive },
      });
      if (response.unreadable > 0) this.logger.warn(`Panel: ${response.unreadable} altas con campos no legibles`);
      return response;
    });
  }

  /**
   * Supresión (art. 17) desde el panel: reautenticación con la contraseña del propio admin (como
   * las exportaciones) y la misma supresión que waitlist:delete (suppressedData), por id de fila.
   * Pasa por MfaService.runAttempt (como el cambio de contraseña): lock por usuario, espera activa
   * y contador de fallos POR CUENTA compartido con el MFA, así que adivinar la contraseña aquí no
   * da más intentos que en el resto de la app. Sin IP ni user-agent en ninguna auditoría.
   */
  async suppress(actor: MfaActor, id: string, password: string, now: Date = new Date()): Promise<void> {
    await this.mfa.runAttempt<true>(actor, PLATFORM_AUDIT_ACTIONS.REAUTH_FAILED, {}, {
      attempt: async (tx, user) => {
        if (!(await compare(password, user.passwordHash))) {
          await writePlatformAudit(tx, {
            actorId: actor.userId,
            action: PLATFORM_AUDIT_ACTIONS.REAUTH_FAILED,
            entityType: 'PlatformAdmin',
            metadata: { operation: 'waitlist-delete' },
          });
          this.logger.warn('Panel: supresión rechazada por contraseña incorrecta');
          return fail('bad_password', new UnauthorizedException({ statusCode: 401, code: 'PLATFORM_REAUTH_FAILED', message: 'Contraseña incorrecta' }));
        }
        // Contraseña correcta: se reinicia el contador de fallos (como el cambio de contraseña).
        await tx.user.update({ where: { id: user.id }, data: RESET_FAILURES });
        if (!ENTRY_ID.test(id)) return reject(null, new NotFoundException('Alta no encontrada'));
        const count = await suppressWaitlistEntryById(tx, id, now);
        if (count !== 1) return reject(null, new NotFoundException('Alta no encontrada'));
        await writePlatformAudit(tx, {
          actorId: actor.userId,
          action: PLATFORM_AUDIT_ACTIONS.WAITLIST_ENTRY_SUPPRESSED,
          entityType: 'WaitlistEntry',
          entityId: id,
          metadata: {},
        });
        return { kind: 'ok', value: true };
      },
    });
    this.logger.log('Panel: alta de la lista de espera suprimida');
  }
}
