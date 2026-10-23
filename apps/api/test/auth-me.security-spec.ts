import 'reflect-metadata';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';

/**
 * GET /auth/me: datos NO clínicos del propio usuario para todos los roles de personal (recepción y
 * OWNER/ADMIN no clínicos reciben 403 en /dashboard). Rol, isClinician y consulta salen de la BD,
 * acotados al workspace del token.
 */
const WS = 'ws-1';
const member = (overrides: any = {}) => ({
  role: 'ASSISTANT',
  isClinician: false,
  workspace: { id: WS, name: 'Consulta Ficticia' },
  user: { id: 'u-1', email: 'recepcion@example.test', firstName: 'Recepción', lastName: 'Demo', totpEnabled: false },
  ...overrides,
});

function service(row: any) {
  const findFirst = jest.fn(async () => row);
  const prisma = { workspaceMember: { findFirst } } as any;
  return { svc: new AuthService(prisma, {} as any, {} as any), findFirst };
}

describe('GET /auth/me', () => {
  it('ruta GET /auth/me protegida por JwtAuthGuard', () => {
    const handler = AuthController.prototype.me;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('me');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []).map((g: any) => g.name)).toEqual(['JwtAuthGuard']);
  });

  it.each(['OWNER', 'ADMIN', 'THERAPIST', 'ASSISTANT'])('%s recibe solo datos no clínicos, con rol e isClinician de la BD', async (role) => {
    const { svc, findFirst } = service(member({ role, isClinician: role === 'THERAPIST', user: { id: 'u-1', email: 'a@example.test', firstName: 'Nombre', lastName: 'Ficticio', totpEnabled: role !== 'ASSISTANT' } }));
    // El token dice otra cosa: manda la BD.
    const me = await svc.me({ sub: 'u-1', workspaceId: WS, role, email: 'a@example.test' });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, userId: 'u-1', status: 'ACTIVE' } }));
    expect(Object.keys(me).sort()).toEqual(['email', 'firstName', 'isClinician', 'lastName', 'mfaEnabled', 'role', 'userId', 'workspace']);
    expect(me).toMatchObject({ role, isClinician: role === 'THERAPIST', mfaEnabled: role !== 'ASSISTANT', workspace: { id: WS, name: 'Consulta Ficticia' } });
  });

  it('la consulta a la BD no pide nada clínico ni secretos (ni pacientes, ni totpSecret, ni passwordHash)', async () => {
    const { svc, findFirst } = service(member());
    await svc.me({ sub: 'u-1', workspaceId: WS, role: 'ASSISTANT', email: 'x' });
    const select = JSON.stringify((findFirst.mock.calls[0] as any[])[0].select);
    for (const forbidden of ['patient', 'clinical', 'totpSecret', 'passwordHash', 'mfaRecoveryCodes', 'notes']) expect(select).not.toContain(forbidden);
  });

  it('sin membresía en el workspace del token → 401 (no se confía en el token)', async () => {
    const { svc } = service(null);
    await expect(svc.me({ sub: 'u-1', workspaceId: 'ws-otro', role: 'OWNER', email: 'x' })).rejects.toMatchObject({ status: 401 });
  });

  it.each([undefined, '', 'PATIENT', 'portal'])('rol %j que no es de personal → 403', async (role) => {
    const { svc, findFirst } = service(member());
    await expect(svc.me({ sub: 'u-1', workspaceId: WS, role: role as any, email: 'x' })).rejects.toMatchObject({ status: 403 });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('token sin sub o sin workspaceId → 401', async () => {
    const { svc } = service(member());
    await expect(svc.me({ sub: undefined as any, workspaceId: WS, role: 'OWNER', email: 'x' })).rejects.toMatchObject({ status: 401 });
    await expect(svc.me({ sub: 'u-1', workspaceId: undefined as any, role: 'OWNER', email: 'x' })).rejects.toMatchObject({ status: 401 });
  });
});
