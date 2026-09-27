import { Controller, Get, HttpCode, INestApplication, Post, Req } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import * as request from 'supertest';
import { InvalidTrustProxyError, applyTrustProxy, parseTrustProxy } from '../src/config/trust-proxy';

/**
 * Condición de Argos para el piloto: el rate limit por IP de /auth/* no se puede esquivar
 * inventando X-Forwarded-For, y los usuarios reales no comparten contador.
 *
 * supertest conecta desde 127.0.0.1: en estos tests el socket hace de "proxy de Render" cuando
 * la configuración confía en él, y de "cliente directo" cuando no.
 */

@Controller()
class ProbeController {
  @Get('whoami')
  whoami(@Req() req: Request) {
    return { ip: req.ip };
  }

  // Mismo patrón que /auth/login: @Throttle por IP (ThrottlerGuard usa req.ip como tracker).
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  login() {
    return { ok: true };
  }
}

async function buildApp(env: NodeJS.ProcessEnv): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
    controllers: [ProbeController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  }).compile();
  const app = moduleRef.createNestApplication();
  applyTrustProxy(app.getHttpAdapter().getInstance(), env);
  await app.init();
  return app;
}

describe('trust proxy: parseo y validación de TRUST_PROXY', () => {
  it('por defecto: 1 salto en producción, desactivado fuera de producción', () => {
    expect(parseTrustProxy(undefined, 'production')).toBe(1);
    expect(parseTrustProxy('  ', 'production')).toBe(1);
    expect(parseTrustProxy(undefined, 'development')).toBe(false);
    expect(parseTrustProxy(undefined, 'test')).toBe(false);
    expect(parseTrustProxy(undefined, undefined)).toBe(false);
  });

  it('acepta saltos, false y listas de IPs/subredes/alias', () => {
    expect(parseTrustProxy('2', 'production')).toBe(2);
    expect(parseTrustProxy('false', 'production')).toBe(false);
    expect(parseTrustProxy('0', 'production')).toBe(false);
    expect(parseTrustProxy('loopback, 10.0.0.0/8,fd00::/8, 203.0.113.9', 'production')).toEqual([
      'loopback',
      '10.0.0.0/8',
      'fd00::/8',
      '203.0.113.9',
    ]);
  });

  it.each([
    // "true" en cualquier forma: confiaría en la X-Forwarded-For del cliente.
    'true',
    'TRUE',
    ' true ',
    'True',
    // Saltos fuera de rango o no enteros.
    '-1',
    '6',
    '1.5',
    // Direcciones o subredes mal formadas.
    'loopbak',
    '10.0.0.0/33',
    '999.1.1.1',
    'fd00::/129',
    '10.0.0.1/8/1',
    // Listas con entradas vacías o solo comas.
    ',',
    ',,',
    ' , , ',
    '10.0.0.1,',
    ',10.0.0.1',
    '10.0.0.1,,loopback',
  ])(
    'rechaza %p al arrancar',
    (raw) => {
      expect(() => parseTrustProxy(raw, 'production')).toThrow(InvalidTrustProxyError);
    },
  );
});

describe('trust proxy: configuración de producción (NODE_ENV=production, TRUST_PROXY sin definir = 1 salto)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await buildApp({ NODE_ENV: 'production' });
  });
  afterAll(async () => app.close());

  it('usa la IP que añade el proxy de confianza (entrada más a la derecha)', async () => {
    const res = await request(app.getHttpServer()).get('/whoami').set('X-Forwarded-For', '198.51.100.23');
    expect(res.body.ip).toBe('198.51.100.23');
  });

  it('una X-Forwarded-For inventada por el cliente (entradas a la izquierda) no cambia req.ip', async () => {
    // El cliente envía "6.6.6.6"; el proxy de Render AÑADE la IP real al final.
    const res = await request(app.getHttpServer())
      .get('/whoami')
      .set('X-Forwarded-For', '6.6.6.6, 1.1.1.1, 198.51.100.23');
    expect(res.body.ip).toBe('198.51.100.23');
  });

  it('rotar la X-Forwarded-For inventada no esquiva el @Throttle del login', async () => {
    const server = app.getHttpServer();
    const realClient = '198.51.100.77';
    const statuses: number[] = [];
    for (const forged of ['10.1.1.1', '10.2.2.2', '10.3.3.3', '10.4.4.4']) {
      const res = await request(server).post('/login').set('X-Forwarded-For', `${forged}, ${realClient}`);
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it('clientes reales distintos detrás del proxy no comparten contador', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 3; i += 1) {
      await request(server).post('/login').set('X-Forwarded-For', '198.51.100.88');
    }
    const other = await request(server).post('/login').set('X-Forwarded-For', '198.51.100.99');
    expect(other.status).toBe(200);
  });
});

describe('trust proxy: petición que NO viene de un proxy de confianza', () => {
  let app: INestApplication;
  beforeAll(async () => {
    // Solo se confía en una subred del proxy; el socket de la prueba (127.0.0.1) queda fuera,
    // es decir, alguien que llega directamente a la API sin pasar por el proxy.
    app = await buildApp({ NODE_ENV: 'production', TRUST_PROXY: '10.0.0.0/8' });
  });
  afterAll(async () => app.close());

  it('ignora por completo la X-Forwarded-For y usa la IP del socket', async () => {
    const res = await request(app.getHttpServer()).get('/whoami').set('X-Forwarded-For', '6.6.6.6');
    expect(res.body.ip).not.toBe('6.6.6.6');
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
  });

  it('cambiar la cabecera no esquiva el @Throttle', async () => {
    const server = app.getHttpServer();
    const statuses: number[] = [];
    for (const forged of ['6.6.6.1', '6.6.6.2', '6.6.6.3']) {
      statuses.push((await request(server).post('/login').set('X-Forwarded-For', forged)).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe('trust proxy: el proxy de confianza está en la lista', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await buildApp({ NODE_ENV: 'production', TRUST_PROXY: 'loopback' });
  });
  afterAll(async () => app.close());

  it('respeta la IP del cliente que añade el proxy', async () => {
    const res = await request(app.getHttpServer()).get('/whoami').set('X-Forwarded-For', '6.6.6.6, 198.51.100.5');
    expect(res.body.ip).toBe('198.51.100.5');
  });
});

describe('trust proxy: local/CI (sin NODE_ENV=production)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await buildApp({ NODE_ENV: 'test' });
  });
  afterAll(async () => app.close());

  it('ignora X-Forwarded-For', async () => {
    const res = await request(app.getHttpServer()).get('/whoami').set('X-Forwarded-For', '6.6.6.6');
    expect(res.body.ip).not.toBe('6.6.6.6');
  });
});
