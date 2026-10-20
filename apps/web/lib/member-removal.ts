import type {
  MemberPendingWorkContract,
  MemberReassignResultContract,
  MemberRemovalPreviewContract,
  MemberRemovalReason,
  MemberRemovalResultContract,
  MemberWorkReassignmentContract,
  StaffRole,
} from '@asepsico/contracts';
import { api, ApiError } from './api';

/*
 * Baja de un miembro del equipo (docs/producto/mejoras-salida-y-confianza.md, historia B). La
 * API decide quién puede dar de baja a quién; aquí solo se ocultan acciones que seguro fallarían.
 */

const seg = encodeURIComponent;

export const REMOVAL_REASONS: MemberRemovalReason[] = ['LEFT_PRACTICE', 'END_OF_COLLABORATION', 'LEAVE_OF_ABSENCE', 'OTHER'];

export const REMOVAL_REASON_LABEL: Record<MemberRemovalReason, string> = {
  LEFT_PRACTICE: 'Deja la consulta',
  END_OF_COLLABORATION: 'Fin de la colaboración',
  LEAVE_OF_ABSENCE: 'Baja temporal o excedencia',
  OTHER: 'Otro motivo',
};

export const getRemovalPreview = (userId: string) =>
  api<MemberRemovalPreviewContract>(`/workspace-members/${seg(userId)}/removal-preview`);

export const removeMember = (userId: string, body: { reassignToUserId?: string; reason?: MemberRemovalReason }) =>
  api<MemberRemovalResultContract>(`/workspace-members/${seg(userId)}/remove`, { method: 'POST', body: JSON.stringify(body) });

export const reassignMemberWork = (userId: string, toUserId: string) =>
  api<MemberReassignResultContract>(`/workspace-members/${seg(userId)}/reassign`, { method: 'POST', body: JSON.stringify({ toUserId }) });

/** OWNER: a cualquiera menos a sí mismo. ADMIN: solo a terapeutas y asistentes. Nunca a uno mismo. */
export function canRemoveMember(viewer: { userId: string | null; role: StaffRole | null } | null, member: { userId: string; role: StaffRole; status?: string }) {
  if (!viewer?.userId || member.userId === viewer.userId || member.status === 'REMOVED') return false;
  if (viewer.role === 'OWNER') return true;
  if (viewer.role === 'ADMIN') return member.role === 'THERAPIST' || member.role === 'ASSISTANT';
  return false;
}

export function hasPendingWork(pending: MemberPendingWorkContract): boolean {
  return pending.activeProcesses + pending.pausedProcesses + pending.futureSessions > 0;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 procesos activos, 1 en pausa y 5 citas futuras" (solo lo que no es cero). */
export function pendingSummary(pending: MemberPendingWorkContract): string {
  const parts = [
    pending.activeProcesses ? plural(pending.activeProcesses, 'proceso activo', 'procesos activos') : '',
    pending.pausedProcesses ? plural(pending.pausedProcesses, 'proceso en pausa', 'procesos en pausa') : '',
    pending.futureSessions ? plural(pending.futureSessions, 'cita futura', 'citas futuras') : '',
  ].filter(Boolean);
  if (!parts.length) return 'nada';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}

/** Mensaje claro para cada error de la baja o la reasignación (400/409 con código estable). */
export function removalErrorMessage(err: unknown, names: { member: string; target?: string | null }): string {
  if (!(err instanceof ApiError)) return 'No se ha podido completar. Comprueba tu conexión y vuelve a intentarlo.';
  const conflicts = typeof err.body.conflicts === 'number' ? err.body.conflicts : null;
  const target = names.target || 'el profesional elegido';
  switch (err.code) {
    case 'REASSIGN_PROCESS_CONFLICT':
      return `${target} ya tiene un proceso abierto con ${conflicts === 1 ? 'uno de estos pacientes' : conflicts ? `${conflicts} de estos pacientes` : 'alguno de estos pacientes'}. No se ha hecho ningún cambio: elige a otra persona o «Decidir después» y resuélvelo caso a caso.`;
    case 'REASSIGN_SCHEDULE_CONFLICT':
      return `${conflicts === 1 ? 'Una cita se solapa' : conflicts ? `${conflicts} citas se solapan` : 'Algunas citas se solapan'} con la agenda de ${target}. No se ha hecho ningún cambio: elige a otra persona, libera esos huecos o «Decidir después».`;
    case 'LAST_OWNER':
      return 'No puedes dar de baja a la única persona titular de la consulta.';
    case 'SELF_REMOVAL_NOT_ALLOWED':
      return 'No puedes darte de baja a ti desde aquí.';
    case 'MEMBER_ALREADY_REMOVED':
      return `${names.member} ya estaba de baja. Recarga la lista.`;
    case 'MEMBER_STILL_ACTIVE':
      return `${names.member} sigue en el equipo: para pasar su trabajo, primero dale de baja.`;
    case 'MEMBER_CHANGED':
      return 'Algo ha cambiado mientras se guardaba (otra persona estaba haciendo cambios). No se ha hecho nada: vuelve a intentarlo.';
    case 'NOTHING_TO_REASSIGN':
      return `${names.member} no atiende pacientes: no hay nada que pasar a otra persona.`;
    case 'INVALID_REASSIGN_TARGET':
      return 'El destino tiene que ser otro profesional del equipo que atienda pacientes.';
    default:
      if (err.status === 403) return 'No tienes permiso para dar de baja a esta persona.';
      if (err.status === 404) return 'No encontramos a esta persona en el equipo. Recarga la lista.';
      return err.message || 'No se ha podido completar.';
  }
}

/** Líneas del resumen tras la baja o la reasignación (recuentos, sin pacientes ni contenido). */
export function removalSummaryLines(
  memberName: string,
  result: { reassignment: MemberWorkReassignmentContract | null; pending: MemberPendingWorkContract; revokedSessions?: number; rejectedAppointmentRequests?: number },
  targetName: string | null,
): string[] {
  const lines: string[] = [];
  if (result.revokedSessions !== undefined) {
    lines.push(`${memberName} ya no tiene acceso a la consulta${result.revokedSessions ? ` (se han cerrado ${plural(result.revokedSessions, 'sesión abierta', 'sesiones abiertas')})` : ''}.`);
  }
  if (result.rejectedAppointmentRequests) {
    lines.push(`Se han rechazado ${plural(result.rejectedAppointmentRequests, 'solicitud de cita pendiente', 'solicitudes de cita pendientes')}; el paciente verá «contacta con la consulta».`);
  }
  const r = result.reassignment;
  if (r) {
    lines.push(`Han pasado a ${targetName ?? 'el profesional elegido'} ${plural(r.processes, 'proceso', 'procesos')} y ${plural(r.futureSessions, 'cita futura', 'citas futuras')}.`);
    if (r.keptSessionsWithPrivateNotes) {
      lines.push(`${r.keptSessionsWithPrivateNotes === 1 ? 'Una cita sigue' : `${r.keptSessionsWithPrivateNotes} citas siguen`} a nombre de ${memberName} porque ${r.keptSessionsWithPrivateNotes === 1 ? 'tiene' : 'tienen'} notas internas suyas. Revísalas en la agenda.`);
    }
    if (r.archivedProcessNotes) {
      lines.push(`Sus notas internas de ${plural(r.archivedProcessNotes, 'proceso', 'procesos')} se conservan con su autoría y no las verá ${targetName ?? 'el nuevo profesional'}.`);
    }
  }
  if (hasPendingWork(result.pending)) {
    lines.push(`Siguen a nombre de ${memberName}: ${pendingSummary(result.pending)}. Puedes pasarlos a otra persona desde Equipo cuando lo decidas.`);
  }
  return lines;
}
