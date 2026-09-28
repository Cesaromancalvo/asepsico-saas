import { randomBytes } from 'crypto';
import {
  DECRYPTION_FAILED_PLACEHOLDER,
  activeEncryptionKid,
  decryptField,
  decryptFieldStrict,
  encryptField,
  encryptedValueKid,
} from '../src/common/crypto/field-encryption';

// Claves generadas en cada ejecución: nunca hay claves reales en el repo.
const LEGACY_KEY = randomBytes(32).toString('base64');
const KEY_2025 = randomBytes(32).toString('base64');
const KEY_2026 = randomBytes(32).toString('base64');
const VARS = ['FIELD_ENCRYPTION_KEY', 'FIELD_ENCRYPTION_KEYS', 'FIELD_ENCRYPTION_ACTIVE_KID', 'NODE_ENV'] as const;

describe('Cifrado de campos: rotación de clave (enc:v2:<kid>) compatible con enc:v1', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const v of VARS) saved[v] = process.env[v]; for (const v of VARS) delete process.env[v]; process.env.NODE_ENV = 'test'; });
  afterEach(() => { for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; } });

  it('sin llavero configurado se mantiene el comportamiento actual: escribe enc:v1 con FIELD_ENCRYPTION_KEY', () => {
    process.env.FIELD_ENCRYPTION_KEY = LEGACY_KEY;
    const value = encryptField('Texto clínico ficticio')!;
    expect(value).toMatch(/^enc:v1:/);
    expect(activeEncryptionKid()).toBe('v1');
    expect(decryptField(value)).toBe('Texto clínico ficticio');
  });

  it('un valor v1 sigue siendo legible tras pasar a v2 (FIELD_ENCRYPTION_KEY se mantiene para leer v1)', () => {
    process.env.FIELD_ENCRYPTION_KEY = LEGACY_KEY;
    const v1 = encryptField('Antecedente ficticio v1')!;
    process.env.FIELD_ENCRYPTION_KEYS = `k2025:${KEY_2025}`;
    process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'k2025';
    const v2 = encryptField('Antecedente ficticio v2')!;
    expect(v2).toMatch(/^enc:v2:k2025:/);
    expect(encryptedValueKid(v2)).toBe('k2025');
    expect(decryptField(v1)).toBe('Antecedente ficticio v1');
    expect(decryptField(v2)).toBe('Antecedente ficticio v2');
  });

  it('un valor v2 con un kid antiguo sigue siendo legible después de rotar la clave activa', () => {
    process.env.FIELD_ENCRYPTION_KEYS = `k2025:${KEY_2025}`;
    process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'k2025';
    const old = encryptField('Observación ficticia antigua')!;
    process.env.FIELD_ENCRYPTION_KEYS = `k2025:${KEY_2025},k2026:${KEY_2026}`;
    process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'k2026';
    const fresh = encryptField('Observación ficticia nueva')!;
    expect(fresh).toMatch(/^enc:v2:k2026:/);
    expect(decryptField(old)).toBe('Observación ficticia antigua');
    expect(decryptField(fresh)).toBe('Observación ficticia nueva');
  });

  it('kid desconocido: la lectura normal devuelve el marcador y la estricta lanza (el script nunca sobrescribe)', () => {
    process.env.FIELD_ENCRYPTION_KEYS = `k2025:${KEY_2025}`;
    process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'k2025';
    const value = encryptField('Dato ficticio')!;
    process.env.FIELD_ENCRYPTION_KEYS = `k2026:${KEY_2026}`;
    process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'k2026';
    expect(decryptField(value)).toBe(DECRYPTION_FAILED_PLACEHOLDER);
    expect(() => decryptFieldStrict(value)).toThrow(/kid "k2025"/);
  });

  it('un valor v2 manipulado no se descifra en silencio (GCM autenticado)', () => {
    process.env.FIELD_ENCRYPTION_KEYS = `k2025:${KEY_2025}`;
    process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'k2025';
    const value = encryptField('Dato ficticio')!;
    const parts = value.split(':');
    parts[parts.length - 1] = Buffer.from('manipulado').toString('base64');
    expect(decryptField(parts.join(':'))).toBe(DECRYPTION_FAILED_PLACEHOLDER);
  });

  it('configuración de llavero incompleta o mal formada lanza en vez de cifrar con otra clave', () => {
    process.env.FIELD_ENCRYPTION_KEYS = `k2025:${KEY_2025}`;
    expect(() => encryptField('x')).toThrow(/FIELD_ENCRYPTION_ACTIVE_KID/);
    process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'otro';
    expect(() => encryptField('x')).toThrow(/FIELD_ENCRYPTION_ACTIVE_KID/);
    process.env.FIELD_ENCRYPTION_KEYS = 'sin-separador';
    expect(() => encryptField('x')).toThrow(/mal formado/);
  });

  it('en producción sigue siendo obligatoria FIELD_ENCRYPTION_KEY si no hay llavero', () => {
    process.env.NODE_ENV = 'production';
    expect(() => encryptField('x')).toThrow(/FIELD_ENCRYPTION_KEY es obligatorio/);
  });

  it('texto en claro antiguo, null y cadena vacía se devuelven tal cual', () => {
    expect(decryptField('texto antiguo en claro')).toBe('texto antiguo en claro');
    expect(decryptField(null)).toBeNull();
    expect(encryptField('')).toBe('');
  });
});
