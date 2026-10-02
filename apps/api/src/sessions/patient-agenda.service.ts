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
/** Tope de filas por respuesta: la agenda de un paciente nunca debería acercarse. */
const MAX_ROWS = 500;

export type PatientAgendaVisibility = 'FULL' | 'BUSY';

/**
 * Agenda de un paciente (GET /sessions/patient/:patientId/agenda), decisión del 02/10:
 *
 *  - THERAPIST: solo si TRATA al paciente (proceso ACTIVO propio, según ClinicalAccessService; si
 *    no, 403 auditado). Sus citas → metadatos de agenda, como GET /sessions (`FULL`). Las citas
 *    del paciente con OTROS profesionales → solo id, inicio, fin, estado y profesional (`BUSY`).
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

    const where: Prisma.SessionWhereInput = {
      workspaceId,
      patientId,
      ...(query.from || query.to
        ? { startsAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } }
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
    const data = rows.map((row) => {
      const full = view === 'ADMINISTRATIVE' || row.therapistId === actor.sub;
      return full
        ? { ...projectSelect<typeof row>(row, SESSION_LIST_SELECT), visibility: 'FULL' as PatientAgendaVisibility }
        : { ...projectSelect<BusyRow>(row, SESSION_BUSY_SELECT), visibility: 'BUSY' as PatientAgendaVisibility };
    });

    const now = Date.now();
    const nextSession = data.find((item) => item.status === SessionStatus.SCHEDULED && new Date(item.startsAt).getTime() >= now) ?? null;

    return { patientId, view, data, nextSession };
  }
}
