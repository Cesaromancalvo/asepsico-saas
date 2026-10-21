import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import ActivationHandoff from '../components/ActivationHandoff';
import SignupRequestCard, { PROFESSIONAL_REMOVED_LABEL } from '../components/SignupRequestCard';
import { ageInYears, MIN_SIGNUP_AGE, PORTAL_SIGNUP_NOTICE_VERSIONS, tokenFromHash } from '../lib/portal-signup';
import { FORBIDDEN_PHRASES, LAYER1, LAYER2, plain, PORTAL_TERMS, PORTAL_TERMS_LABEL, PRIVACY_ACK_LABEL } from '../lib/portal-signup-texts';
import type { SignupRequest } from '../lib/portal-signup';

const WEB_ROOT = join(__dirname, '..');
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd'.padEnd(43, 'x').slice(0, 43);
const activation = { token: TOKEN, expiresAt: '2026-10-23T10:00:00.000Z', delivery: 'IN_PERSON_ONLY' as const };

const noop = () => undefined;
const request = (patch: Partial<SignupRequest> = {}): SignupRequest => ({
  id: 'req1', professionalId: 'th1', firstName: 'Lucía', lastName: 'Ejemplo Ficticio', email: 'lucia@example.test', phone: null,
  birthDate: '1990-05-04', createdAt: '2026-10-19T09:00:00.000Z', expiresAt: '2026-11-02T09:00:00.000Z', ...patch,
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (['node_modules', '.next', 'test'].includes(entry)) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('Entrega del enlace de activación (IN_PERSON_ONLY)', () => {
  const html = renderToStaticMarkup(<ActivationHandoff activation={activation} origin="https://app.example.test" />);

  it('muestra el QR de activación y la caducidad', () => {
    expect(html).toContain('<svg');
    expect(html).toContain('Código QR para activar la cuenta del portal');
    expect(html).toContain('caduca el');
  });

  it('no hay ningún botón ni enlace para enviarlo, copiarlo o compartirlo', () => {
    expect(html).not.toMatch(/<button/i);
    expect(html).not.toMatch(/<a\s/i);
    expect(html).not.toMatch(/mailto:|wa\.me|whatsapp:|sms:|tel:/i);
    expect(html).not.toMatch(/>\s*(Enviar|Compartir|Copiar)/i);
  });

  it('ningún archivo de la web ofrece enviar el enlace de activación por correo, WhatsApp o compartir', () => {
    const offenders = sourceFiles(WEB_ROOT).filter((file) => {
      const text = readFileSync(file, 'utf8');
      if (!/activation/i.test(text)) return false;
      return /mailto:|wa\.me|api\.whatsapp|navigator\.share|whatsapp:\/\//i.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('el diálogo de activación no tiene botón de copiar ni de enviar', () => {
    const dialog = readFileSync(join(WEB_ROOT, 'components', 'ActivationDialog.tsx'), 'utf8');
    expect(dialog).not.toMatch(/clipboard|navigator\.share|mailto:|Enviar/);
  });
});

describe('Bandeja de altas', () => {
  it('una solicitud de un profesional dado de baja lleva la etiqueta neutra y no su nombre', () => {
    const html = renderToStaticMarkup(
      <SignupRequestCard request={request({ professionalRemoved: true })} professionalName="Ana García" selected={false} busy={false}
        onToggle={noop} onCreate={noop} onLink={noop} onReject={noop} />,
    );
    expect(html).toContain(PROFESSIONAL_REMOVED_LABEL);
    expect(html).not.toContain('Ana García');
  });

  it('solo enseña datos administrativos y las tres acciones', () => {
    const html = renderToStaticMarkup(
      <SignupRequestCard request={request()} professionalName="Ana García" selected={false} busy={false}
        onToggle={noop} onCreate={noop} onLink={noop} onReject={noop} />,
    );
    expect(html).toContain('Para Ana García');
    expect(html).toContain('Vincular a su ficha');
    expect(html).toContain('Crear paciente nuevo');
    expect(html).toContain('Rechazar');
    expect(html).not.toMatch(/motivo|nota|diagn/i);
  });
});

describe('Alta pública', () => {
  it('las versiones de los textos coinciden con las de la API', () => {
    const config = readFileSync(join(WEB_ROOT, '..', 'api', 'src', 'portal-signup', 'portal-signup.config.ts'), 'utf8');
    expect(config).toContain(`'${PORTAL_SIGNUP_NOTICE_VERSIONS.privacyNotice}'`);
    expect(config).toContain(`'${PORTAL_SIGNUP_NOTICE_VERSIONS.portalTerms}'`);
  });

  it('la edad mínima coincide con la de la API', () => {
    const config = readFileSync(join(WEB_ROOT, '..', 'api', 'src', 'portal-signup', 'portal-signup.config.ts'), 'utf8');
    expect(config).toMatch(new RegExp(`MIN_SIGNUP_AGE_YEARS = ${MIN_SIGNUP_AGE};`));
  });

  it('ningún texto del alta usa las frases que Lex prohíbe ni nombra al profesional', () => {
    const all = [
      plain(LAYER1.title), plain(LAYER1.intro), LAYER1.introStrong, LAYER1.introEnd, LAYER1.heading,
      ...LAYER1.items.map((i) => plain(i.text)), ...LAYER2.rows.map((r) => plain(r.text)),
      plain(PORTAL_TERMS.title), ...PORTAL_TERMS.items.map((i) => plain(i.text)), PRIVACY_ACK_LABEL, PORTAL_TERMS_LABEL,
    ].join(' ');
    for (const phrase of FORBIDDEN_PHRASES) expect(all).not.toMatch(phrase);
    expect(all).not.toMatch(/\{nombre_profesional\}|tu psic[oó]log[oa] .* responsable/i);
    const page = readFileSync(join(WEB_ROOT, 'app', 'portal', 'alta', 'page.tsx'), 'utf8');
    for (const phrase of FORBIDDEN_PHRASES) expect(page).not.toMatch(phrase);
  });

  it('el título es de solicitud (enviar no crea cuenta) y los datos pendientes se ven como marcador', () => {
    expect(plain(LAYER1.title)).toBe('Solicitud de acceso al portal de pacientes de [Datos de la consulta pendientes]');
  });

  it('las casillas no hablan de consentir y la página no ofrece WhatsApp (C7, C15)', () => {
    const page = readFileSync(join(WEB_ROOT, 'app', 'portal', 'alta', 'page.tsx'), 'utf8');
    expect(`${PRIVACY_ACK_LABEL} ${PORTAL_TERMS_LABEL}`).not.toMatch(/consiento/i);
    expect(page).not.toMatch(/whatsapp/i);
    expect(page).not.toMatch(/\bchecked=\{true\}|defaultChecked/);
  });

  it('lee el token solo del fragmento y con el formato exacto', () => {
    expect(tokenFromHash(`#t=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash('#t=corto')).toBeNull();
    expect(tokenFromHash('')).toBeNull();
  });

  it('calcula la edad como la API (los años se cumplen el mismo día)', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    expect(ageInYears('2008-10-20', now)).toBe(18);
    expect(ageInYears('2008-10-21', now)).toBe(17);
  });
});
