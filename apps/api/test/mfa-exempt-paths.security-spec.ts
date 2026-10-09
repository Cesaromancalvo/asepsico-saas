import { ExecutionContext } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isMfaSetupAllowedPath, JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';

/**
 * Excepción del MFA obligatorio (JwtAuthGuard.handleRequest): igual que la C2 de Argos para el 428,
 * solo quedan exentas las rutas EXACTAS (normalizadas) de configurar el MFA y cerrar sesión bajo
 * /api/v1. Antes se decidía con endsWith y cualquier ruta que solo terminara igual quedaba exenta.
 */
describe('JwtAuthGuard: excepción del MFA por ruta exacta normalizada', () => {
  const therapistWithoutMfa = { sub: 'u-1', workspaceId: 'ws-1', role: 'THERAPIST', mfaEnabled: false };
  const ctx = (url: string) => ({ switchToHttp: () => ({ getRequest: () => ({ originalUrl: url, url }) }) }) as unknown as ExecutionContext;
  const guard = new JwtAuthGuard();

  it.each([
    '/api/v1/patients/x/auth/logout',
    '/api/v1/patients/p-1/auth/mfa/setup',
    '/api/v1/messages/c-1/auth/mfa/confirm',
    '/api/v1/exports/auth/logout',
    '/otro/api/v1/auth/logout',
    '/api/v2/auth/mfa/setup',
    '/auth/mfa/setup',
    '/api/v1/auth/mfa/setup/../../../patients',
    '/api/v1/auth/mfa/setupx',
  ])('%s solo termina parecido → 403 sin MFA', (path) => {
    expect(isMfaSetupAllowedPath(path)).toBe(false);
    expect(() => guard.handleRequest(null, therapistWithoutMfa, null, ctx(path))).toThrow(/verificación en dos pasos/);
  });

  it.each([
    '/api/v1/auth/mfa/setup',
    '/api/v1/auth/mfa/confirm',
    '/api/v1/auth/logout',
    '/api/v1/auth/logout/',
    '/api/v1/auth/mfa/setup?x=1',
    '/API/V1/Auth/MFA/Confirm',
  ])('%s es exenta exacta (normalizada) → pasa sin MFA', (path) => {
    expect(isMfaSetupAllowedPath(path)).toBe(true);
    expect(guard.handleRequest(null, therapistWithoutMfa, null, ctx(path))).toBe(therapistWithoutMfa);
  });

  it('ASSISTANT y usuarios con MFA activo no se ven afectados', () => {
    expect(guard.handleRequest(null, { ...therapistWithoutMfa, role: 'ASSISTANT' }, null, ctx('/api/v1/patients'))).toBeTruthy();
    expect(guard.handleRequest(null, { ...therapistWithoutMfa, mfaEnabled: true }, null, ctx('/api/v1/patients'))).toBeTruthy();
  });

  it('el 403 lleva code MFA_SETUP_REQUIRED (la web no depende del texto) y conserva el mensaje', () => {
    let error: any;
    try { guard.handleRequest(null, therapistWithoutMfa, null, ctx('/api/v1/patients')); } catch (e) { error = e; }
    expect(error?.getStatus()).toBe(403);
    expect(error.getResponse()).toEqual({ statusCode: 403, code: 'MFA_SETUP_REQUIRED', message: 'Activa la verificación en dos pasos antes de continuar' });
  });

  it('el guard ya no decide la excepción con endsWith', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'common', 'guards', 'jwt-auth.guard.ts'), 'utf8');
    expect(src).not.toMatch(/endsWith\(/);
  });
});
