import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { compare } from 'bcryptjs';
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

  constructor(private readonly prisma: PrismaService) {}

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
   */
  async suppress(actorId: string, id: string, password: string, now: Date = new Date()): Promise<void> {
    const account = await this.prisma.user.findUnique({ where: { id: actorId }, select: { passwordHash: true } });
    const passwordOk = account ? await compare(password, account.passwordHash) : false;
    if (!passwordOk) {
      await writePlatformAudit(this.prisma, {
        actorId,
        action: PLATFORM_AUDIT_ACTIONS.REAUTH_FAILED,
        entityType: 'PlatformAdmin',
        metadata: { operation: 'waitlist-delete' },
      });
      this.logger.warn('Panel: supresión rechazada por contraseña incorrecta');
      throw new UnauthorizedException({ statusCode: 401, code: 'PLATFORM_REAUTH_FAILED', message: 'Contraseña incorrecta' });
    }

    if (!ENTRY_ID.test(id)) throw new NotFoundException('Alta no encontrada');
    await this.prisma.$transaction(async (tx) => {
      const count = await suppressWaitlistEntryById(tx, id, now);
      if (count !== 1) throw new NotFoundException('Alta no encontrada');
      await writePlatformAudit(tx, {
        actorId,
        action: PLATFORM_AUDIT_ACTIONS.WAITLIST_ENTRY_SUPPRESSED,
        entityType: 'WaitlistEntry',
        entityId: id,
        metadata: {},
      });
    });
    this.logger.log('Panel: alta de la lista de espera suprimida');
  }
}
