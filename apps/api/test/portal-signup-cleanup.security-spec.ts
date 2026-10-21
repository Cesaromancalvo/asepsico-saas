import { Logger } from '@nestjs/common';
import {
  PortalSignupCleanupService, SIGNUP_CLEANUP_INTERVAL_MS, SIGNUP_CLEANUP_STARTUP_DELAY_MS,
} from '../src/portal-signup/portal-signup-cleanup.service';
import { PortalSignupModule } from '../src/portal-signup/portal-signup.module';
import { SignupRequestsService } from '../src/portal-signup/signup-requests.service';
import { audits, pendingRequest, rows, seed } from './support/portal-signup-fixture';

/**
 * Purga automática de solicitudes de alta caducadas (recomendación de Dora): al arrancar con
 * retraso, cada hora, nada en tests, temporizadores unref() y fallos sin datos. Datos ficticios.
 */
describe('PortalSignupCleanupService', () => {
  const originalEnv = process.env.NODE_ENV;
  let service: PortalSignupCleanupService | undefined;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    service?.onModuleDestroy();
    service = undefined;
    process.env.NODE_ENV = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('está registrado en PortalSignupModule', () => {
    expect(Reflect.getMetadata('providers', PortalSignupModule)).toContain(PortalSignupCleanupService);
  });

  it('con NODE_ENV=test no programa nada', () => {
    process.env.NODE_ENV = 'test';
    const purgeExpired = jest.fn(async () => 0);
    service = new PortalSignupCleanupService({ purgeExpired } as any);
    service.onModuleInit();
    jest.advanceTimersByTime(SIGNUP_CLEANUP_INTERVAL_MS * 3);
    expect(purgeExpired).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('purga una vez al arrancar (con retraso, sin bloquear) y después cada hora; timers con unref', () => {
    process.env.NODE_ENV = 'production';
    const purgeExpired = jest.fn(async () => 0);
    const unrefs: jest.SpyInstance[] = [];
    const realSetTimeout = global.setTimeout;
    const realSetInterval = global.setInterval;
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any, ms: any) => { const t: any = realSetTimeout(fn, ms); unrefs.push(jest.spyOn(t, 'unref')); return t; }) as any);
    jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms: any) => { const t: any = realSetInterval(fn, ms); unrefs.push(jest.spyOn(t, 'unref')); return t; }) as any);

    service = new PortalSignupCleanupService({ purgeExpired } as any);
    service.onModuleInit(); // no espera a la purga
    expect(purgeExpired).not.toHaveBeenCalled();
    expect(unrefs).toHaveLength(2);
    for (const spy of unrefs) expect(spy).toHaveBeenCalled();

    jest.advanceTimersByTime(SIGNUP_CLEANUP_STARTUP_DELAY_MS);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(SIGNUP_CLEANUP_INTERVAL_MS);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(SIGNUP_CLEANUP_INTERVAL_MS * 2);
    expect(purgeExpired).toHaveBeenCalledTimes(4);

    service.onModuleDestroy();
    jest.advanceTimersByTime(SIGNUP_CLEANUP_INTERVAL_MS * 2);
    expect(purgeExpired).toHaveBeenCalledTimes(4);
  });

  it('si falla, solo avisa con el tipo de error: sin mensaje ni datos, y no lanza', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = Object.assign(new Error('fallo con lucia.ficticia@example.com y token-secreto'), { name: 'PrismaClientKnownRequestError' });
    service = new PortalSignupCleanupService({ purgeExpired: jest.fn(async () => { throw error; }) } as any);
    await expect(service.runOnce()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain('PrismaClientKnownRequestError');
    expect(logged).not.toMatch(/example\.com|token-secreto|fallo con/);
  });

  it('es idempotente: borra las caducadas una vez y la segunda pasada no hace nada', async () => {
    jest.useRealTimers();
    const prisma = seed();
    await pendingRequest(prisma);
    await pendingRequest(prisma, undefined, { email: 'otra@example.com' });
    rows(prisma, 'portalSignupRequest')[0].expiresAt = new Date(Date.now() - 1000);
    service = new PortalSignupCleanupService(new SignupRequestsService(prisma));
    await service.runOnce();
    await service.runOnce();
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);
    expect(audits(prisma, 'PORTAL_SIGNUP_REQUEST_EXPIRED')).toHaveLength(1);
  });
});
