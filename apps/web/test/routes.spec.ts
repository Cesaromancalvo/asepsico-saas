import { describe, expect, it } from '@jest/globals';
import { appHref, legacyToStatic, patientHref, processHref, queryId, sessionHref } from '../lib/routes';

/*
 * Salida de Vercel: la web es un export estático y las rutas con id pasan a query string.
 * Condiciones de Argos: los ids leídos de la URL solo se aceptan con forma de cuid (no pueden
 * reescribir la ruta de la API) y legacyToStatic solo produce rutas internas fijas.
 */
const P = 'cm1a2b3c4d5e6f7g8h9i0j1k2'; // cuid ficticio
const S = 'cm9z8y7x6w5v4u3t2s1r0q9p8';

const HOSTILE = ['', '/', '..', '../x', 'a/b', '?', 'a?b=c', '%2F', 'cm1a2b3c4d5e6f7g8h9i%2Fadmin', '//evil.com/x',
  'cm1a2b3c4d5e6f7g8h9i0j1k2/../../admin', 'CM1A2B3C4D5E6F7G8H9I0J1K2', 'short1', 'a'.repeat(41),
  '11111111-2222-4333-8444-555555555555', ' cm1a2b3c4d5e6f7g8h9i0j1k2'];

describe('queryId', () => {
  it('accepts cuid-shaped ids', () => {
    expect(queryId(P)).toBe(P);
    expect(queryId('a'.repeat(20))).toBe('a'.repeat(20));
    expect(queryId('a'.repeat(40))).toBe('a'.repeat(40));
  });
  it('rejects /, .., ?, %2F, //evil.com/x and anything that is not a cuid', () => {
    for (const v of [...HOSTILE, `${P}#x`, `${P}?a=b`]) expect(queryId(v)).toBe('');
    expect(queryId(null)).toBe('');
    expect(queryId(undefined)).toBe('');
  });
});

describe('routes', () => {
  it('builds the new static URLs with a trailing slash and the id in the query', () => {
    expect(patientHref(P)).toBe(`/patients/view/?id=${P}`);
    expect(patientHref(P, 'tasks')).toBe(`/patients/view/tasks/?id=${P}`);
    expect(processHref(P, S)).toBe(`/patients/view/process/?id=${P}&processId=${S}`);
    expect(sessionHref(S)).toBe(`/agenda/session/?id=${S}`);
  });

  it('translates every legacy URL the API and old bookmarks use', () => {
    expect(legacyToStatic(`/patients/${P}`)).toBe(patientHref(P));
    expect(legacyToStatic(`/patients/${P}/`)).toBe(patientHref(P));
    for (const s of ['assessments', 'documents', 'plan', 'portal', 'resources', 'tasks'] as const) {
      expect(legacyToStatic(`/patients/${P}/${s}`)).toBe(patientHref(P, s));
    }
    expect(legacyToStatic(`/patients/${P}/processes/${S}`)).toBe(processHref(P, S));
    expect(legacyToStatic(`/agenda/${S}`)).toBe(sessionHref(S));
    expect(legacyToStatic(`/agenda/${S}?tab=notes#top`)).toBe(sessionHref(S));
  });

  it('rejects legacy URLs whose ids are not cuids (/, .., ?, %2F, //evil.com/x)', () => {
    for (const bad of HOSTILE) {
      expect(legacyToStatic(`/patients/${bad}`)).toBeNull();
      expect(legacyToStatic(`/agenda/${bad}`)).toBeNull();
      expect(legacyToStatic(`/patients/${P}/processes/${bad}`)).toBeNull();
    }
    for (const href of ['//evil.com/x', '//evil.com/patients/' + P, 'https://evil.com/patients/' + P,
      `/patients/${P}/../../admin`, `/patients/%2F${P}`, `/agenda/${S}/extra`]) {
      expect(legacyToStatic(href)).toBeNull();
    }
  });

  it('whatever the input, a non-null result always starts with /patients/view/ or /agenda/session/', () => {
    const inputs = [...HOSTILE.flatMap((b) => [`/patients/${b}`, `/agenda/${b}`, `/patients/${P}/${b}`, `/patients/${P}/processes/${b}`]),
      `/patients/${P}`, `/patients/${P}/plan`, `/patients/${P}/processes/${S}`, `/agenda/${S}`, '/patients/view/x', '/agenda/session/x'];
    for (const href of inputs) {
      const out = legacyToStatic(href);
      if (out !== null) expect(out.startsWith('/patients/view/') || out.startsWith('/agenda/session/')).toBe(true);
    }
  });

  it('leaves new and unrelated URLs alone', () => {
    for (const href of ['/', '/patients', '/patients/', '/agenda', '/agenda?patientId=x', '/messages?patientId=x',
      patientHref(P), patientHref(P, 'plan'), processHref(P, S), sessionHref(S), `/patients/${P}/unknown`]) {
      expect(legacyToStatic(href)).toBeNull();
      expect(appHref(href)).toBe(href);
    }
  });
});

describe('legacyToStatic: casos hostiles adicionales (condición de Argos, 23/10)', () => {
  it('protocolo relativo, barra invertida y rutas codificadas → null', () => {
    for (const href of ['//evil.com/patients/x', `//evil.com/patients/${P}/plan`, '/\\evil.com', `/\\evil.com/patients/${P}`,
      '/patients/%2F..%2F/plan', `/patients/%2F..%2F${P}/plan`, `/patients/${P}%2F..%2F/plan`]) {
      expect(legacyToStatic(href)).toBeNull();
    }
  });

  it('ids con mayúsculas o con punto → null', () => {
    for (const id of ['CM1A2B3C4D5E6F7G8H9I0J1K2', 'cm1a2b3c4d5E6f7g8h9i0j1k2', 'cm1a2b3c4d5e6f7g8h9i0j1k.', 'cm1a2b3c4d.e6f7g8h9i0j1k2']) {
      expect(legacyToStatic(`/patients/${id}`)).toBeNull();
      expect(legacyToStatic(`/patients/${id}/plan`)).toBeNull();
      expect(legacyToStatic(`/patients/${P}/processes/${id}`)).toBeNull();
      expect(legacyToStatic(`/agenda/${id}`)).toBeNull();
    }
  });

  it('la query original (p. ej. ?next=https://evil) nunca viaja al destino', () => {
    const out = legacyToStatic(`/patients/${P}/processes/${S}?next=https://evil.example/x#frag`);
    expect(out).toBe(processHref(P, S));
    expect(out).not.toMatch(/evil|next=|#/);
    expect(legacyToStatic(`/agenda/${S}?next=https://evil.example`)).toBe(sessionHref(S));
  });
});
