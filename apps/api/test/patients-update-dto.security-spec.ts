import { readFileSync } from 'fs';
import { join } from 'path';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import { UpdatePatientDto } from '../src/patients/dto/update-patient.dto';

/**
 * PATCH /patients/:id no debe permitir tocar campos de ciclo de vida ni de tenant.
 * `status` y `blockedAt` solo cambian por los endpoints dedicados (/status, /block, /archive,
 * /restore) y `workspaceId` nunca viene del cliente. El ValidationPipe global
 * (whitelist + forbidNonWhitelisted) es lo que hace que esos campos provoquen un 400.
 *
 * Datos 100 % ficticios.
 */

// Mismas opciones de validación que el ValidationPipe global de apps/api/src/main.ts.
const GLOBAL_PIPE_OPTIONS: ValidatorOptions = { whitelist: true, forbidNonWhitelisted: true };

async function errorsFor(body: Record<string, unknown>) {
  const dto = plainToInstance(UpdatePatientDto, body);
  return validate(dto, GLOBAL_PIPE_OPTIONS);
}

describe('UpdatePatientDto bajo las opciones del ValidationPipe global', () => {
  it('main.ts sigue declarando whitelist y forbidNonWhitelisted en el pipe global', () => {
    const main = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/useGlobalPipes\(\s*new ValidationPipe\(\{[^}]*whitelist:\s*true/);
    expect(main).toMatch(/useGlobalPipes\(\s*new ValidationPipe\(\{[^}]*forbidNonWhitelisted:\s*true/);
  });

  it.each([
    ['status ACTIVE', { status: 'ACTIVE' }],
    ['status ARCHIVED', { status: 'ARCHIVED' }],
    ['status BLOCKED', { status: 'BLOCKED' }],
    ['blockedAt null', { blockedAt: null }],
    ['blockedAt fecha', { blockedAt: '2026-01-01T00:00:00.000Z' }],
    ['workspaceId ajeno', { workspaceId: 'ws-ajeno' }],
    ['deletedAt null', { deletedAt: null }],
    ['campo legítimo + status', { firstName: 'Lucía', status: 'ACTIVE' }],
    ['campo legítimo + blockedAt', { lastName: 'Ficticia', blockedAt: null }],
    ['campo legítimo + workspaceId', { phone: '600 000 000', workspaceId: 'ws-ajeno' }],
  ])('rechaza el cuerpo con %s', async (_label, body) => {
    const errors = await errorsFor(body);
    expect(errors.length).toBeGreaterThan(0);
    const forbidden = Object.keys(body).filter((k) =>
      ['status', 'blockedAt', 'workspaceId', 'deletedAt'].includes(k),
    );
    const offending = errors.map((e) => e.property);
    for (const key of forbidden) {
      expect(offending).toContain(key);
      const err = errors.find((e) => e.property === key)!;
      expect(Object.keys(err.constraints ?? {})).toContain('whitelistValidation');
    }
  });

  it.each([
    ['nombre y apellidos', { firstName: 'Lucía', lastName: 'Ficticia' }],
    ['contacto', { email: 'paciente.ficticio@example.com', phone: '+34 600 000 000' }],
    ['modo de portal', { portalAccessMode: 'SHARED' }],
    ['cuerpo vacío', {}],
  ])('acepta un cuerpo legítimo (%s)', async (_label, body) => {
    const errors = await errorsFor(body);
    expect(errors).toEqual([]);
  });
});
