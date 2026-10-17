import { describe, expect, it } from '@jest/globals';
import { appHref, legacyToStatic, patientHref, processHref, sessionHref } from '../lib/routes';

/*
 * Salida de Vercel: la web es un export estático y las rutas con id pasan a query string.
 * Los enlaces que genera la API (línea temporal, panel) y los marcadores antiguos siguen
 * usando /patients/<id>/... y /agenda/<id>: deben traducirse sin perder el id ni la query.
 */
const P = '11111111-2222-4333-8444-555555555555';
const S = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('routes', () => {
  it('builds the new static URLs with a trailing slash and the id in the query', () => {
    expect(patientHref(P)).toBe(`/patients/view/?id=${P}`);
    expect(patientHref(P, 'tasks')).toBe(`/patients/view/tasks/?id=${P}`);
    expect(processHref(P, S)).toBe(`/patients/view/process/?id=${P}&processId=${S}`);
    expect(sessionHref(S)).toBe(`/agenda/session/?id=${S}`);
  });

  it('encodes ids so a crafted value cannot add query parameters', () => {
    expect(patientHref('a&b=c')).toBe('/patients/view/?id=a%26b%3Dc');
  });

  it('translates every legacy URL the API and old bookmarks use', () => {
    expect(legacyToStatic(`/patients/${P}`)).toBe(patientHref(P));
    expect(legacyToStatic(`/patients/${P}/`)).toBe(patientHref(P));
    for (const s of ['assessments', 'documents', 'plan', 'portal', 'resources', 'tasks'] as const) {
      expect(legacyToStatic(`/patients/${P}/${s}`)).toBe(patientHref(P, s));
    }
    expect(legacyToStatic(`/patients/${P}/processes/${S}`)).toBe(processHref(P, S));
    expect(legacyToStatic(`/agenda/${S}`)).toBe(sessionHref(S));
    expect(legacyToStatic(`/agenda/${S}?tab=notes#top`)).toBe(`${sessionHref(S)}&tab=notes#top`);
  });

  it('leaves new and unrelated URLs alone', () => {
    for (const href of ['/', '/patients', '/patients/', '/agenda', '/agenda?patientId=x', '/messages?patientId=x',
      patientHref(P), patientHref(P, 'plan'), processHref(P, S), sessionHref(S), `/patients/${P}/unknown`]) {
      expect(legacyToStatic(href)).toBeNull();
      expect(appHref(href)).toBe(href);
    }
  });
});

describe('routes (robustness)', () => {
  it('returns null instead of throwing on malformed percent-encoding (404 page must not crash)', () => {
    expect(legacyToStatic('/patients/%E0%A4%A')).toBeNull();
  });
});
