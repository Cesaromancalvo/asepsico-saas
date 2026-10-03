import { ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, SessionStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { ClinicalAccessService } from '../clinical-access/clinical-access.service';
import { projectSelect } from '../patients/patient-view.util';
import { PatientAgendaQueryDto } from './dto/patient-agenda-query.dto';
import { SESSION_BUSY_SELECT, SESSION_LIST_SELECT } from './session-view.util';

/** Roles con vista administrativa de la agenda (todas las citas del paciente, sin contenido). */
const ADMINISTRATIVE_ROLES = ['OWNER', 'ADMIN', 'ASSISTANT'];
/**
 * Procesos cuyas citas ajenas se muestran como hueco: un proceso cerrado o de alta de otro
 * profesional es historial ajeno y no sale (sus citas futuras se cancelan al cerrarlo).
 */
const LIVE_PROCESS_STATUSES = ['ACTIVE', 'PAUSED'] as const;
type LiveStatus = (typeof LIVE_PROCESS_STATUSES)[number];
/** Tope de filas por respuesta: la agenda de un paciente nunca debería acercarse. */
const MAX_ROWS = 500;

export type PatientAgendaVisibility = 'FULL' | 'BUSY';

/**
 * Agenda de un paciente (GET /sessions/patient/:patientId/agenda), decisión del 02/10:
 *
 *  - THERAPIST: solo si TRATA al paciente (proceso ACTIVO propio, según ClinicalAccessService; si
 *    no, 403 auditado). Sus citas → metadatos de agenda, como GET /sessions (`FULL`). De las citas
 *    del paciente con OTROS profesionales solo salen las SCHEDULED futuras, y solo con id, inicio,
 *    fin y profesional (`BUSY`): ni estado, ni ausencias, ni cancelaciones, ni historial.
 *  - OWNER, ADMIN, ASSISTANT: vista administrativa, todas las citas con metadatos de agenda (lo
 *    mismo que ya ven en GET /sessions?patientId=).
 *
 * Nunca devuelve notes, internalSummary ni título del proceso: cada fila se proyecta con lista
 * blanca aunque la consulta trajera la fila completa. Todo acotado al workspace.
 */
@Injectable()
export class PatientAgendaService {
  private readonly access: ClinicalAccessService;

  constructor(private readonly prisma: PrismaService, @Optional() access?: ClinicalAccessService) {
    this.access = access ?? new ClinicalAccessService(prisma);
  }

  async agenda(workspaceId: string, actor: AuthUser, patientId: string, query: PatientAgendaQueryDto = {}) {
    assertStaffRole(actor);

    let view: 'TREATING' | 'ADMINISTRATIVE';
    if (actor.role === 'THERAPIST') {
      // Comprueba también que el paciente es del workspace (404) y audita la denegación.
      await this.access.assertTreating(workspaceId, actor, patientId, 'patient-agenda');
      view = 'TREATING';
    } else if (ADMINISTRATIVE_ROLES.includes(actor.role)) {
      const patient = await this.prisma.patient.findFirst({ where: { id: patientId, workspaceId }, select: { id: true } });
      if (!patient) throw new NotFoundException('Paciente no encontrado');
      view = 'ADMINISTRATIVE';
    } else {
      throw new ForbiddenException('No autorizado');
    }

    const now = new Date();
    const where: Prisma.SessionWhereInput = {
      workspaceId,
      patientId,
      ...(query.from || query.to
        ? { startsAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } }
        : {}),
      // Vista clínica: las propias completas; las ajenas, solo programadas y futuras.
      ...(view === 'TREATING'
        ? { OR: [{ therapistId: actor.sub }, { status: SessionStatus.SCHEDULED, startsAt: { gte: now }, clinicalProcess: { status: { in: [...LIVE_PROCESS_STATUSES] } } }] }
        : {}),
    };

    // Consulta con la proyección más amplia permitida; la decisión FULL/BUSY es fila a fila.
    const rows = await this.prisma.session.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: MAX_ROWS,
      select: SESSION_LIST_SELECT,
    });

    type BusyRow = Prisma.SessionGetPayload<{ select: typeof SESSION_BUSY_SELECT }>;
    const isUpcoming = (row: { status: SessionStatus; startsAt: Date }) =>
      row.status === SessionStatus.SCHEDULED && new Date(row.startsAt).getTime() >= now.getTime();
    const toItem = (row: (typeof rows)[number]) => {
      if (view === 'ADMINISTRATIVE' || row.therapistId === actor.sub) {
        return { ...projectSelect<typeof row>(row, SESSION_LIST_SELECT), visibility: 'FULL' as PatientAgendaVisibility };
      }
      // Defensa en profundidad: aunque la consulta trajera una ajena pasada o no programada, no sale.
      if (!isUpcoming(row) || !LIVE_PROCESS_STATUSES.includes(row.clinicalProcess?.status as LiveStatus)) return null;
      return { ...projectSelect<BusyRow>(row, SESSION_BUSY_SELECT), visibility: 'BUSY' as PatientAgendaVisibility };
    };
    const items = rows.map((row) => ({ row, item: toItem(row) })).filter((entry) => entry.item !== null);
    const data = items.map((entry) => entry.item!);

    // Próxima cita con cualquier profesional (decidida sobre la fila, no sobre la proyección).
    const nextSession = items.find((entry) => isUpcoming(entry.row))?.item ?? null;

    return { patientId, view, data, nextSession };
  }
}
