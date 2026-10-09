import { readFileSync } from 'fs';
import { join } from 'path';
import { DEMO_PATIENTS, FICTION_PREFIX, FORBIDDEN_DEMO_TERMS } from '../prisma/scripts/demo/demo-dataset';
import {
  assertDemoEnvironment, assertEncryptionConfigured, assertEncryptionKeyMatchesDatabase, assertNoRealPatients,
  DemoRefusal, isLocalDatabaseUrl, parseTargetArgs, resolveDemoTarget, safeErrorMessage,
} from '../prisma/scripts/demo/demo-guards';
import { demoPatientEmail, randomPassword } from '../prisma/scripts/demo/demo-writer';
import { encryptField } from '../src/common/crypto/field-encryption';

/**
 * Espacio de demostración (db:seed-demo-workspace / db:purge-demo-workspace): se niega a escribir
 * fuera de un entorno demo o sobre un espacio con pacientes reales, y el contenido sembrado es
 * claramente inventado, adulto y sin temas sensibles.
 */
const scriptsDir = join(__dirname, '..', 'prisma', 'scripts');
const read = (file: string) => readFileSync(join(scriptsDir, file), 'utf8');

describe('Espacio demo: barreras de seguridad del script', () => {
  it.each([undefined, '', 'false', '1', 'TRUE', 'yes', ' true'])('DEMO_ENVIRONMENT=%j → se niega', (value) => {
    const env = value === undefined ? {} : { DEMO_ENVIRONMENT: value };
    expect(() => assertDemoEnvironment(env as any)).toThrow(DemoRefusal);
  });

  it('DEMO_ENVIRONMENT=true exacto → sigue', () => {
    expect(() => assertDemoEnvironment({ DEMO_ENVIRONMENT: 'true' } as any)).not.toThrow();
  });

  it('contra una BD no local exige la clave de cifrado de ese entorno', () => {
    expect(() => assertEncryptionConfigured({ DATABASE_URL: 'postgresql://u:p@db.remoto.example:5432/x' } as any)).toThrow(/FIELD_ENCRYPTION_KEY/);
    expect(() => assertEncryptionConfigured({ DATABASE_URL: 'postgresql://u:p@db.remoto.example:5432/x', FIELD_ENCRYPTION_KEY: 'k' } as any)).not.toThrow();
    expect(() => assertEncryptionConfigured({ DATABASE_URL: 'postgresql://u:p@db.remoto.example:5432/x', FIELD_ENCRYPTION_KEYS: 'a:k' } as any)).not.toThrow();
    expect(() => assertEncryptionConfigured({ DATABASE_URL: 'postgresql://u:p@localhost:5432/x' } as any)).not.toThrow();
  });

  it.each([
    ['postgresql://u:p@localhost:5432/x', true],
    ['postgresql://u:p@127.0.0.1:5432/x', true],
    ['postgresql://u:p@[::1]:5432/x', true],
    ['postgresql://u:p@localhost.evil.example:5432/x', false],
    ['postgresql://u:p@db.example:5432/localhost', false],
    ['no-es-una-url', false],
  ])('isLocalDatabaseUrl(%s) = %s', (url, expected) => {
    expect(isLocalDatabaseUrl(url)).toBe(expected);
  });

  it('exige exactamente un destino (--workspace-id o --owner-email)', () => {
    expect(() => parseTargetArgs([])).toThrow(DemoRefusal);
    expect(() => parseTargetArgs(['--workspace-id', 'w', '--owner-email', 'a@b.es'])).toThrow(DemoRefusal);
    expect(() => parseTargetArgs(['--owner-email', 'no-es-correo'])).toThrow(DemoRefusal);
    expect(() => parseTargetArgs(['--workspace-id', '--yes'])).toThrow(DemoRefusal);
    expect(parseTargetArgs(['--owner-email=Titular@Ejemplo.ES'])).toEqual({ workspaceId: undefined, ownerEmail: 'titular@ejemplo.es' });
  });

  it('se niega si el espacio tiene algún paciente sin marca demo (cuenta también archivados)', async () => {
    const count = jest.fn(async () => 1);
    await expect(assertNoRealPatients({ patient: { count } } as any, 'ws-1')).rejects.toThrow(/no son de demostración/);
    expect(count).toHaveBeenCalledWith({ where: { workspaceId: 'ws-1', isDemo: false } });
    await expect(assertNoRealPatients({ patient: { count: async () => 0 } } as any, 'ws-1')).resolves.toBeUndefined();
  });

  it('se niega si el espacio no tiene exactamente un OWNER o el correo es titular de varios', async () => {
    const db = (owners: any[], owned: any[] = [{ workspaceId: 'ws-1' }]) => ({
      user: { findUnique: async () => ({ id: 'u-1' }) },
      workspace: { findUnique: async () => ({ id: 'ws-1', name: 'Demo' }) },
      workspaceMember: { findMany: async ({ where }: any) => (where.userId ? owned : owners) },
    }) as any;
    await expect(resolveDemoTarget(db([]), { workspaceId: 'ws-1' })).rejects.toThrow(DemoRefusal);
    await expect(resolveDemoTarget(db([{}, {}]), { workspaceId: 'ws-1' })).rejects.toThrow(DemoRefusal);
    await expect(resolveDemoTarget(db([{ id: 'm', userId: 'u-1', isClinician: false }], [{ workspaceId: 'a' }, { workspaceId: 'b' }]), { ownerEmail: 'a@b.es' })).rejects.toThrow(/varios espacios/);
    await expect(resolveDemoTarget(db([{ id: 'm', userId: 'u-1', isClinician: false }]), { ownerEmail: 'a@b.es' })).resolves.toMatchObject({ workspaceId: 'ws-1', ownerUserId: 'u-1' });
  });

  it('se niega si la clave configurada no descifra ninguno de los datos cifrados existentes', async () => {
    const foreign = 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA';
    const db = (value: string | null) => new Proxy({}, { get: (_t, model: string) => ({ findFirst: async () => (value ? { notes: value, internalNotes: value, consultationReason: value, body: value, currentProblem: value } : null) }) });
    await expect(assertEncryptionKeyMatchesDatabase(db(foreign) as any)).rejects.toThrow(/no descifra/);
    await expect(assertEncryptionKeyMatchesDatabase(db(encryptField('ok')!) as any)).resolves.toBeUndefined();
    await expect(assertEncryptionKeyMatchesDatabase(db(null) as any)).resolves.toBeUndefined();
  });

  it('los errores nunca vuelcan detalles (solo el mensaje propio o el código de Prisma)', () => {
    expect(safeErrorMessage(new Error('postgresql://usuario:secreto@host/db'))).not.toMatch(/secreto|postgresql/);
    expect(safeErrorMessage({ code: 'P2002', meta: { target: ['email'] } })).toBe('error de base de datos P2002');
  });

  it('contraseñas aleatorias, largas y distintas en cada llamada', () => {
    const a = randomPassword();
    expect(a.length).toBeGreaterThanOrEqual(24);
    expect(a).not.toBe(randomPassword());
  });
});

describe('Espacio demo: el contenido sembrado es claramente inventado', () => {
  const texts = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(texts);
    if (value && typeof value === 'object') return Object.values(value).flatMap(texts);
    return [];
  };

  it('entre 8 y 12 pacientes, con nombres distintos', () => {
    expect(DEMO_PATIENTS.length).toBeGreaterThanOrEqual(8);
    expect(DEMO_PATIENTS.length).toBeLessThanOrEqual(12);
    expect(new Set(DEMO_PATIENTS.map((p) => `${p.firstName} ${p.lastName}`)).size).toBe(DEMO_PATIENTS.length);
  });

  it('apellidos obviamente ficticios y correos @example.test', () => {
    for (const p of DEMO_PATIENTS) {
      expect(p.lastName).toMatch(/^(Demo|Ejemplo|Ejemplar|Prueba|Inventad[oa]|Fictici[oa]|Simulad[oa]|Muestra)$/);
      expect(demoPatientEmail(p, 'abcd1234')).toMatch(/^[a-z0-9.]+@example\.test$/);
    }
  });

  it('solo personas adultas y acceso al portal solo del propio paciente', () => {
    for (const p of DEMO_PATIENTS) expect(p.ageYears).toBeGreaterThanOrEqual(18);
    expect(read('demo/demo-writer.ts')).toMatch(/accessorType: 'PATIENT'/);
    expect(read('demo/demo-writer.ts')).not.toMatch(/GUARDIAN/);
  });

  it('todo texto narrativo lleva la marca de ficción y ningún término sensible', () => {
    const narrative = DEMO_PATIENTS.flatMap((p) => texts({ ...p, firstName: null, lastName: null, processes: p.processes.map((x) => ({ ...x, title: null, modality: null, frequency: null, status: null })), status: null, clinician: null, tasks: p.tasks.map((t) => ({ ...t, status: null })), goals: p.goals.map((g) => ({ ...g, status: null })), assessments: null, messages: p.messages.map((m) => m.body) }));
    expect(narrative.length).toBeGreaterThan(50);
    for (const text of narrative) expect(text.startsWith(FICTION_PREFIX)).toBe(true);
    const all = DEMO_PATIENTS.flatMap(texts).join('\n').toLowerCase();
    for (const term of FORBIDDEN_DEMO_TERMS) expect(all).not.toContain(term);
  });

  it('hay procesos ACTIVE, PAUSED y CLOSED, sesiones pasadas y futuras, tareas, escalas y mensajes', () => {
    const statuses = new Set(DEMO_PATIENTS.flatMap((p) => p.processes.map((x) => x.status)));
    expect([...statuses].sort()).toEqual(['ACTIVE', 'CLOSED', 'PAUSED']);
    expect(DEMO_PATIENTS.some((p) => p.processes.some((x) => x.futureSessions > 0))).toBe(true);
    expect(DEMO_PATIENTS.some((p) => p.tasks.length && p.portal)).toBe(true);
    expect(DEMO_PATIENTS.some((p) => p.messages.length && p.portal)).toBe(true);
    expect(DEMO_PATIENTS.some((p) => p.assessments.length)).toBe(true);
    expect(DEMO_PATIENTS.some((p) => p.clinician === 'THERAPIST')).toBe(true);
  });

  it('nunca siembra el PHQ-9 (tiene un ítem de riesgo) ni alertas de riesgo', () => {
    for (const p of DEMO_PATIENTS) for (const a of p.assessments) expect(['GAD7', 'WHO5']).toContain(a.scaleCode);
    expect(read('demo/demo-writer.ts')).toMatch(/riskFlag: false/);
  });
});

describe('Espacio demo: escrituras acotadas y marcadas', () => {
  it('el purge solo borra pacientes y usuarios marcados como demo, acotado al workspace', () => {
    const purge = read('purge-demo-workspace.ts');
    expect(purge).toMatch(/patient\.deleteMany\(\{ where: \{ workspaceId, isDemo: true/);
    expect(purge).toMatch(/user\.deleteMany\(\{ where: \{ id: member\.userId, isDemo: true \} \}\)/);
    expect(purge).toMatch(/user\.updateMany\(\{\s*where: \{ id: member\.userId, isDemo: true \}/);
    for (const m of purge.matchAll(/\.(deleteMany|updateMany)\(\{ where: ([^\n]+)/g)) {
      expect(m[2]).toMatch(/workspaceId|inPatients|isDemo: true|userId: member\.userId/);
    }
    expect(purge).not.toMatch(/workspace\.delete/);
    expect(purge).toMatch(/--yes/);
  });

  it('el seed marca a pacientes y usuarios como demo, deja DEMO_SEED y solo imprime contraseñas en un sitio', () => {
    const seed = read('seed-demo-workspace.ts');
    const writer = read('demo/demo-writer.ts');
    expect(writer).toMatch(/workspaceId, isDemo: true/);
    expect(seed).toMatch(/isDemo: true \}/);
    expect(seed).toMatch(/action: 'DEMO_SEED'/);
    expect(seed).toMatch(/assertNoRealPatients\(tx/);
    expect((seed.match(/password/g) ?? []).filter(Boolean).length).toBeGreaterThan(0);
    // Las contraseñas solo salen por printCredentials (stdout), nunca en console.error ni en la auditoría.
    expect(seed).not.toMatch(/console\.error\([^)]*password/);
    expect(seed).not.toMatch(/metadata: \{[^}]*password/);
  });

  it('el seed cifra todos los campos narrativos que escribe', () => {
    const writer = read('demo/demo-writer.ts');
    for (const field of ['consultationReason', 'currentProblem', 'internalNotes', 'notes', 'internalSummary', 'instructions', 'patientFeedback', 'reviewComment', 'interpretation', 'body']) {
      expect(writer).toMatch(new RegExp(`${field}: encrypt`));
    }
    expect(writer).toMatch(/answers: encryptJsonField/);
    expect(writer).toMatch(/result: encryptAssessmentResult/);
  });
});
