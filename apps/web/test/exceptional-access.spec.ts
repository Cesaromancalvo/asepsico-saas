import { describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '@/lib/api';
import {
  EMPTY_EXCEPTIONAL_FORM,
  EXCEPTIONAL_ACCESS_REASONS,
  FOREIGN_HISTORY_MESSAGE,
  OpeningCancelled,
  buildExceptionalRequest,
  canDeferNotice,
  exceptionalAllowsExport,
  formatClinicalAccessNotice,
  minutesLeft,
  pendingReviews,
  registerRows,
  remainingText,
  validateExceptionalForm,
  visibleReasons,
  withOpeningReason,
  type ExceptionalAccessForm,
} from '@/lib/exceptional-access';
import ExceptionalAccessDialog from '@/components/ExceptionalAccessDialog';
import ExceptionalAccessBanner from '@/components/ExceptionalAccessBanner';
import { OpeningReasonFieldset } from '@/components/OpeningReasonPicker';
import { accessHistoryRows } from '@/components/PatientAccessHistory';
import { ClinicalSubpageView, subpageMode } from '@/components/ClinicalSubpageGate';
import { initialDialogState } from '@/components/ExceptionalAccessDialog';
import { safeInternalPath } from '@/lib/exceptional-access';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// La barra lateral usa el router de Next: fuera de la app se simula la ruta.
jest.mock('next/navigation', () => ({ usePathname: () => '/patients/p1', useRouter: () => ({ push: () => undefined }), useParams: () => ({ id: 'p1' }) }));

const ADMIN_REASONS = ['PATIENT_RIGHTS_REQUEST', 'LEGAL_REQUIREMENT', 'CLAIM_DEFENCE', 'CUSTODY', 'DATA_INCIDENT'];
const valid: ExceptionalAccessForm = { ...EMPTY_EXCEPTIONAL_FORM, reasonCode: 'LEGAL_REQUIREMENT', justification: 'Requerimiento del Juzgado n.º 3, procedimiento 123/2026.', confirmed: true };

describe('Modal de acceso excepcional: validación', () => {
  it('catálogo cerrado: nunca hay "Otro" y sin perfil clínico solo los 5 administrativos', () => {
    expect(EXCEPTIONAL_ACCESS_REASONS).toHaveLength(7);
    expect(visibleReasons([...ADMIN_REASONS, 'OTHER'])).toEqual(ADMIN_REASONS);
    expect(visibleReasons([...EXCEPTIONAL_ACCESS_REASONS])).toHaveLength(7);
    expect(visibleReasons(undefined)).toEqual([]);
  });

  it('[Abrir historia] solo se habilita con motivo, explicación de 20–300 y casilla (CA1.4)', () => {
    const allowed = visibleReasons(ADMIN_REASONS);
    expect(validateExceptionalForm(EMPTY_EXCEPTIONAL_FORM, allowed, 'OWNER')?.field).toBe('reasonCode');
    expect(validateExceptionalForm({ ...valid, justification: 'demasiado corta' }, allowed, 'OWNER')?.field).toBe('justification');
    expect(validateExceptionalForm({ ...valid, justification: 'x'.repeat(301) }, allowed, 'OWNER')?.field).toBe('justification');
    expect(validateExceptionalForm({ ...valid, confirmed: false }, allowed, 'OWNER')?.field).toBe('confirmed');
    // Un motivo clínico no permitido a quien no tiene perfil clínico (CA1.6).
    expect(validateExceptionalForm({ ...valid, reasonCode: 'VITAL_URGENCY' }, allowed, 'OWNER')?.field).toBe('reasonCode');
    expect(validateExceptionalForm(valid, allowed, 'OWNER')).toBeNull();
  });

  it('diferir el aviso: solo OWNER y solo en tres motivos; exige motivo de diferimiento', () => {
    expect(canDeferNotice('OWNER', 'LEGAL_REQUIREMENT')).toBe(true);
    expect(canDeferNotice('ADMIN', 'LEGAL_REQUIREMENT')).toBe(false);
    expect(canDeferNotice('OWNER', 'VITAL_URGENCY')).toBe(false);
    const allowed = visibleReasons(ADMIN_REASONS);
    expect(validateExceptionalForm({ ...valid, deferNotice: true, deferReason: 'corto' }, allowed, 'OWNER')?.field).toBe('deferReason');
    // Un ADMIN no puede diferir: aunque marque la casilla, ni se valida ni se envía.
    expect(buildExceptionalRequest({ ...valid, deferNotice: true, deferReason: 'x'.repeat(25) }, 'ADMIN')).not.toHaveProperty('deferNotice');
    expect(buildExceptionalRequest({ ...valid, deferNotice: true, deferReason: ` ${'y'.repeat(25)} ` }, 'OWNER')).toMatchObject({ deferNotice: true, deferReason: 'y'.repeat(25) });
  });

  it('el cuerpo lleva confirmed: true y el reconocimiento del aviso de términos clínicos solo si se ha pulsado', () => {
    expect(buildExceptionalRequest(valid, 'OWNER')).toEqual({ reasonCode: 'LEGAL_REQUIREMENT', justification: valid.justification, confirmed: true });
    expect(buildExceptionalRequest(valid, 'OWNER', true)).toMatchObject({ clinicalTermWarningAcknowledged: true });
  });

  it('la exportación completa solo aparece con los tres motivos que la permiten (C5)', () => {
    expect(['PATIENT_RIGHTS_REQUEST', 'LEGAL_REQUIREMENT', 'CLAIM_DEFENCE'].every(exceptionalAllowsExport)).toBe(true);
    expect(['CONTINUITY_OF_CARE', 'VITAL_URGENCY', 'CUSTODY', 'DATA_INCIDENT'].some(exceptionalAllowsExport)).toBe(false);
  });
});

describe('Modal de acceso excepcional: lo que se pinta', () => {
  const render = (allowedReasons: string[]) => renderToStaticMarkup(createElement(ExceptionalAccessDialog, {
    open: true, patientId: 'p1', role: 'ADMIN', allowedReasons, onClose: () => undefined, onRegistered: () => undefined,
  }));

  it('un solo modal con aviso, motivos, explicación y confirmación; botón desactivado al empezar', () => {
    const html = render(ADMIN_REASONS);
    expect(html).toContain('Vas a abrir la historia de un paciente que no atiendes');
    expect(html).toContain('dura 8 horas');
    expect(html).toContain('El paciente puede leer esta explicación.');
    expect(html).toContain('art. 16.6 de la Ley 41/2002');
    expect(html).toContain('Mi motivo no está en la lista');
    expect((html.match(/type="radio"/g) ?? []).length).toBe(5);
    expect(html).not.toMatch(/>Otro</);
    expect(html).not.toContain('Urgencia: riesgo grave');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Abrir historia<\/button>/);
    // Un ADMIN no ve la opción de diferir el aviso.
    expect(html).not.toContain('Diferir el aviso');
  });

  it('con perfil clínico aparecen los 7 motivos, marcados como clínicos o administrativos', () => {
    const html = render([...EXCEPTIONAL_ACCESS_REASONS]);
    expect((html.match(/type="radio"/g) ?? []).length).toBe(7);
    expect(html).toContain('Urgencia: riesgo grave e inmediato');
    expect(html).toContain('Clínico');
  });

  it('cerrado no pinta nada del formulario', () => {
    const html = renderToStaticMarkup(createElement(ExceptionalAccessDialog, { open: false, patientId: 'p1', role: 'OWNER', allowedReasons: ADMIN_REASONS, onClose: () => undefined, onRegistered: () => undefined }));
    expect(html).not.toContain('Abrir historia');
  });
});

describe('Banda de acceso vigente', () => {
  it('muestra motivo en lenguaje claro, caducidad y el botón de cerrar', () => {
    const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const html = renderToStaticMarkup(createElement(ExceptionalAccessBanner, { patientId: 'p1', access: { id: 'a1', reasonCode: 'VITAL_URGENCY', expiresAt }, onEnded: () => undefined }));
    expect(html).toContain('Acceso excepcional');
    expect(html).toContain('Urgencia: riesgo grave e inmediato');
    expect(html).toMatch(/hasta (las|el)/);
    expect(html).toContain('No incluye las notas internas');
    expect(html).toContain('Cerrar acceso');
  });

  it('cuenta el tiempo restante y lo da por vencido al pasar la hora', () => {
    const now = new Date('2026-10-16T10:00:00Z');
    expect(remainingText('2026-10-16T18:00:00Z', now)).toBe('quedan 8 h');
    expect(remainingText('2026-10-16T10:45:00Z', now)).toBe('quedan 45 min');
    expect(minutesLeft('2026-10-16T09:00:00Z', now)).toBe(0);
    expect(remainingText('2026-10-16T09:00:00Z', now)).toBe('ha vencido');
  });
});

describe('Selector de motivo de apertura (H6)', () => {
  it('pinta los 4 motivos cerrados, sin texto libre', () => {
    const html = renderToStaticMarkup(createElement(OpeningReasonFieldset, { value: '', onChange: () => undefined }));
    expect(html).toContain('<legend>Motivo de apertura</legend>');
    expect((html.match(/type="radio"/g) ?? []).length).toBe(4);
    expect(html).toContain('Sustitución de otro profesional');
    expect(html).not.toContain('<textarea');
  });

  it('primero sin motivo; si la API lo pide (400 OPENING_REASON_REQUIRED) pregunta y reintenta con él', async () => {
    const call = jest.fn(async (code?: string) => {
      if (!code) throw new ApiError('Indica el motivo', 400, 'OPENING_REASON_REQUIRED');
      return { ok: code };
    });
    const ask = jest.fn(async () => 'SUBSTITUTION' as const);
    await expect(withOpeningReason(call, ask)).resolves.toEqual({ ok: 'SUBSTITUTION' });
    expect(call).toHaveBeenNthCalledWith(1);
    expect(call).toHaveBeenNthCalledWith(2, 'SUBSTITUTION');
  });

  it('sin historia ajena no pregunta nada (CA6.4)', async () => {
    const ask = jest.fn(async () => 'REFERRAL' as const);
    await expect(withOpeningReason(async () => 'creado', ask)).resolves.toBe('creado');
    expect(ask).not.toHaveBeenCalled();
  });

  it('al THERAPIST (403 PATIENT_HAS_FOREIGN_HISTORY) le explica que se lo abre la dirección', async () => {
    const ask = jest.fn(async () => null);
    await expect(withOpeningReason(async () => { throw new ApiError('x', 403, 'PATIENT_HAS_FOREIGN_HISTORY'); }, ask)).rejects.toThrow(FOREIGN_HISTORY_MESSAGE);
    expect(ask).not.toHaveBeenCalled();
  });

  it('si cancela el selector no se reintenta', async () => {
    const call = jest.fn(async (code?: string) => { if (!code) throw new ApiError('x', 400, 'OPENING_REASON_REQUIRED'); return code; });
    await expect(withOpeningReason(call, async () => null)).rejects.toBeInstanceOf(OpeningCancelled);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('Registro, historial y avisos: nunca texto', () => {
  const register = {
    accesses: [{
      type: 'EXCEPTIONAL_ACCESS' as const, id: 'a1', patientId: 'p1', patientInitials: 'AB', actorId: 'u1', actorRole: 'OWNER' as const,
      reasonCode: 'VITAL_URGENCY' as const, createdAt: '2026-10-16T08:00:00Z', expiresAt: '2026-10-16T16:00:00Z', closedAt: null, closeReason: null,
      ownerReviewDueAt: '2026-10-19T08:00:00Z', reviewedAt: null, reviewedById: null, reviewOutcome: null, selfReview: null,
      notificationDeferredAt: null, notificationReleasedAt: null, blockedAt: null, clinicalTermWarningIgnored: false, migratedFromAuditLogId: null,
      status: 'URGENCY_PENDING_REVIEW' as const,
      // Si la API enviara algo de más, la web no lo pinta: registerRows solo copia campos conocidos.
      justification: 'TEXTO QUE NO DEBE SALIR',
    }],
    openings: [{
      type: 'PROCESS_OPENING_OVER_HISTORY' as const, id: 'o1', patientId: 'p2', patientInitials: 'CD', clinicalProcessId: 'c1', actorId: 'u2',
      actorRole: 'ADMIN' as const, targetTherapistId: 'u2', kind: 'OPENED' as const, reasonCode: 'SUBSTITUTION' as const, selfAssigned: true,
      ownerReviewDueAt: '2026-10-18T08:00:00Z', reviewedAt: null, reviewedById: null, reviewOutcome: null, selfReview: null,
      createdAt: '2026-10-15T08:00:00Z', pendingReview: true,
    }],
  };

  it('el registro une accesos y aperturas, ordena las revisiones pendientes y no copia la explicación', () => {
    const rows = registerRows(register);
    expect(rows.map((row) => row.id)).toEqual(['a1', 'o1']);
    expect(JSON.stringify(rows)).not.toContain('TEXTO QUE NO DEBE SALIR');
    expect(rows[0]).toMatchObject({ statusLabel: 'Urgencia pendiente de revisión', reasonLabel: 'Urgencia: riesgo grave e inmediato' });
    expect(pendingReviews(rows).map((row) => row.id)).toEqual(['o1', 'a1']);
  });

  it('"Accesos de otras personas" muestra persona, rol, motivo y duración', () => {
    const rows = accessHistoryRows({
      accesses: [{ id: 'a1', actorId: 'u1', actorName: 'Ana Prueba', actorRole: 'OWNER', reasonCode: 'CUSTODY', createdAt: '2026-10-16T08:00:00Z', expiresAt: '2026-10-16T16:00:00Z', closedAt: '2026-10-16T09:30:00Z', endedAt: '2026-10-16T09:30:00Z' }],
      openings: [{ id: 'o1', actorId: 'u2', actorName: null, actorRole: 'ADMIN', reasonCode: 'REFERRAL', kind: 'REACTIVATED', targetTherapistId: 'u3', createdAt: '2026-10-17T08:00:00Z' }],
    });
    expect(rows[0]).toMatchObject({ what: 'Reactivación de proceso', who: 'Un miembro de la consulta', reason: 'Derivación dentro de la consulta' });
    expect(rows[1]).toMatchObject({ who: 'Ana Prueba', role: 'Titular', reason: 'Custodia de la historia', detail: 'Duración: 1 h 30 min' });
    // Un acceso todavía abierto no muestra una duración inventada.
    const open = accessHistoryRows({ accesses: [{ id: 'a2', actorId: 'u1', actorName: 'Ana Prueba', actorRole: 'OWNER', reasonCode: 'CUSTODY', createdAt: '2026-10-16T08:00:00Z', expiresAt: '2026-10-16T16:00:00Z', closedAt: null, endedAt: '2026-10-16T16:00:00Z' }], openings: [] }, new Date('2026-10-16T09:00:00Z'));
    expect(open[0].detail).toMatch(/^Vigente hasta las/);
  });

  it('el aviso en la app cambia la fecha ISO por una legible', () => {
    const text = formatClinicalAccessNotice('El 2026-10-16T08:30:00.000Z, Ana Prueba (Titular) abrió la historia de A. B. por: Custodia de la historia.');
    expect(text).not.toContain('2026-10-16T');
    expect(text).toMatch(/^El 16\/10\/2026 a las \d{2}:\d{2}, Ana Prueba/);
    expect(formatClinicalAccessNotice('Sin fecha')).toBe('Sin fecha');
  });
});

describe('Condiciones de Argos', () => {
  const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');
  const owner = { userId: 'u1', role: 'OWNER' as const, isClinician: false, firstName: 'Ana', lastName: 'Prueba', workspaceName: null };
  const ready = (treating: boolean) => ({ state: 'ready' as const, processes: [], treating, readable: treating, readOnly: false });

  it('tareas y escalas con acceso excepcional (sin TREATING): ni notas internas ni controles de escritura', () => {
    // EXCEPTIONAL no da TREATING: canReadClinical llega a false en el listado de procesos.
    expect(subpageMode(owner, ready(false))).toBe('blocked');
    expect(subpageMode({ ...owner, role: 'ASSISTANT' }, ready(false))).toBe('blocked');
    expect(subpageMode(owner, { ...ready(false), state: 'loading' })).toBe('loading');
    expect(subpageMode({ ...owner, role: 'THERAPIST', isClinician: true }, ready(true))).toBe('treating');
    const protectedContent = createElement('div', null, 'NOTA CLÍNICA PRIVADA', createElement('button', null, 'Editar'), createElement('button', null, 'Eliminar'));
    for (const section of ['Tareas', 'Escalas']) {
      const html = renderToStaticMarkup(createElement(ClinicalSubpageView, { mode: 'blocked', patientId: 'p1', section, children: protectedContent }));
      expect(html).not.toContain('NOTA CLÍNICA PRIVADA');
      expect(html).not.toMatch(/Editar|Eliminar|<textarea|<form/);
      expect(html).toContain('href="/patients/p1"');
      expect(html).toContain(`${section}: solo para quien atiende al paciente`);
    }
    // Solo con TREATING se monta el contenido.
    expect(renderToStaticMarkup(createElement(ClinicalSubpageView, { mode: 'treating', patientId: 'p1', section: 'Tareas', children: protectedContent }))).toContain('NOTA CLÍNICA PRIVADA');
  });

  it('las dos subpáginas pasan por la puerta antes de montar su contenido', () => {
    for (const page of ['app/patients/[id]/tasks/page.tsx', 'app/patients/[id]/assessments/page.tsx']) {
      expect(source(page)).toMatch(/export default function \w+\(\)\{\s*const \{id:patientId\}=useParams<\{id:string\}>\(\);\s*return <ClinicalSubpageGate/);
    }
  });

  it('el proceso queda en solo lectura siempre que el acceso sea excepcional', () => {
    expect(source('app/patients/[id]/processes/[processId]/page.tsx')).toContain('const readOnly = exceptional || !detail || detail.readOnly');
  });

  it('el enlace de un aviso solo acepta rutas internas: nunca "//host" ni URLs absolutas', () => {
    expect(safeInternalPath('/patients/p1')).toBe('/patients/p1');
    expect(safeInternalPath('//evil.example/patients')).toBeNull();
    expect(safeInternalPath('/\\evil.example')).toBeNull();
    expect(safeInternalPath('https://evil.example')).toBeNull();
    expect(safeInternalPath('javascript:alert(1)')).toBeNull();
    expect(safeInternalPath(undefined)).toBeNull();
    expect(source('app/notifications/page.tsx')).toContain('safeInternalPath(n.actionUrl)');
  });

  it('al cerrar el modal el formulario queda vacío', () => {
    expect(initialDialogState()).toEqual({ form: EMPTY_EXCEPTIONAL_FORM, busy: false, error: '', clinicalWarning: false, reasonMiss: false, created: null });
    // Copia nueva cada vez: no se comparte el objeto entre aperturas.
    expect(initialDialogState().form).not.toBe(EMPTY_EXCEPTIONAL_FORM);
    expect(source('components/ExceptionalAccessDialog.tsx')).toMatch(/function handleClosed\(\) \{[\s\S]*?resetDialog\(\);[\s\S]*?\n  \}/);
  });
});
