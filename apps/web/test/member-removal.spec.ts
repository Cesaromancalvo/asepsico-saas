import { describe, expect, it } from '@jest/globals';
import { ApiError } from '../lib/api';
import { canRemoveMember, pendingSummary, removalErrorMessage, removalSummaryLines } from '../lib/member-removal';

const conflict = (code: string, conflicts?: number) => {
  const err = new ApiError('msg', 409, code);
  err.body = { code, ...(conflicts !== undefined ? { conflicts } : {}) };
  return err;
};

describe('Baja de miembros', () => {
  it('OWNER da de baja a cualquiera menos a sí mismo; ADMIN solo a terapeutas y asistentes', () => {
    const owner = { userId: 'o1', role: 'OWNER' as const };
    const admin = { userId: 'a1', role: 'ADMIN' as const };
    expect(canRemoveMember(owner, { userId: 'o1', role: 'OWNER' })).toBe(false);
    expect(canRemoveMember(owner, { userId: 'a2', role: 'ADMIN' })).toBe(true);
    expect(canRemoveMember(admin, { userId: 'a2', role: 'ADMIN' })).toBe(false);
    expect(canRemoveMember(admin, { userId: 't1', role: 'THERAPIST' })).toBe(true);
    expect(canRemoveMember(admin, { userId: 't1', role: 'THERAPIST', status: 'REMOVED' })).toBe(false);
    expect(canRemoveMember({ userId: 't2', role: 'THERAPIST' }, { userId: 't1', role: 'THERAPIST' })).toBe(false);
  });

  it('explica los 409 de reasignación con el número de conflictos y que no se ha hecho nada', () => {
    const process = removalErrorMessage(conflict('REASSIGN_PROCESS_CONFLICT', 2), { member: 'Ana', target: 'Luis' });
    expect(process).toContain('Luis ya tiene un proceso abierto con 2 de estos pacientes');
    expect(process).toContain('No se ha hecho ningún cambio');
    const schedule = removalErrorMessage(conflict('REASSIGN_SCHEDULE_CONFLICT', 1), { member: 'Ana', target: 'Luis' });
    expect(schedule).toContain('Una cita se solapa con la agenda de Luis');
    expect(removalErrorMessage(conflict('LAST_OWNER'), { member: 'Ana' })).toContain('única persona titular');
  });

  it('el resumen cuenta las citas que se quedan por notas privadas y nunca nombra pacientes', () => {
    const lines = removalSummaryLines('Ana', {
      revokedSessions: 2,
      rejectedAppointmentRequests: 1,
      reassignment: { toUserId: 'l1', processes: 3, futureSessions: 4, keptSessionsWithPrivateNotes: 2, archivedProcessNotes: 1 },
      pending: { activeProcesses: 0, pausedProcesses: 0, futureSessions: 2, pendingAppointmentRequests: 0 },
    }, 'Luis');
    const text = lines.join(' ');
    expect(text).toContain('Han pasado a Luis 3 procesos y 4 citas futuras');
    expect(text).toContain('2 citas siguen a nombre de Ana porque tienen notas internas suyas');
    expect(text).toContain('no las verá Luis');
  });

  it('resume lo pendiente en español natural', () => {
    expect(pendingSummary({ activeProcesses: 1, pausedProcesses: 2, futureSessions: 3, pendingAppointmentRequests: 0 }))
      .toBe('1 proceso activo, 2 procesos en pausa y 3 citas futuras');
  });
});
