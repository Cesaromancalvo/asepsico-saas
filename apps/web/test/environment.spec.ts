import { beforeEach, describe, expect, it, jest } from '@jest/globals';

/*
 * Condición de Argos: el aviso de entorno de prueba falla hacia el lado seguro. Solo un
 * { demo: false } explícito de GET /environment lo oculta; un error, null o {} lo mantienen.
 */
const api = jest.fn<(path: string) => Promise<unknown>>();
jest.mock('../lib/api', () => ({ api: (path: string) => api(path) }));

type EnvironmentModule = typeof import('../lib/environment');

// La caché vive en el módulo: cada caso carga una copia nueva.
function loadModule(): EnvironmentModule {
  let mod!: EnvironmentModule;
  jest.isolateModules(() => {
    mod = require('../lib/environment') as EnvironmentModule;
  });
  return mod;
}

describe('fetchIsDemoEnvironment', () => {
  beforeEach(() => {
    api.mockReset();
  });

  it('devuelve true si la llamada falla', async () => {
    api.mockRejectedValueOnce(new Error('Error de conexión'));
    await expect(loadModule().fetchIsDemoEnvironment()).resolves.toBe(true);
    expect(api).toHaveBeenCalledWith('/environment');
  });

  it('devuelve true si llega null', async () => {
    api.mockResolvedValueOnce(null);
    await expect(loadModule().fetchIsDemoEnvironment()).resolves.toBe(true);
  });

  it('devuelve true si llega {}', async () => {
    api.mockResolvedValueOnce({});
    await expect(loadModule().fetchIsDemoEnvironment()).resolves.toBe(true);
  });

  it.each([[{ demo: true }], [{ demo: 'false' }], [{ demo: 0 }], [{ demo: null }]])('devuelve true con %j', async (body) => {
    api.mockResolvedValueOnce(body);
    await expect(loadModule().fetchIsDemoEnvironment()).resolves.toBe(true);
  });

  it('devuelve false solo con { demo: false }', async () => {
    api.mockResolvedValueOnce({ demo: false });
    await expect(loadModule().fetchIsDemoEnvironment()).resolves.toBe(false);
  });

  it('un fallo no se cachea: el siguiente intento vuelve a preguntar', async () => {
    const mod = loadModule();
    api.mockRejectedValueOnce(new Error('Error de conexión'));
    await expect(mod.fetchIsDemoEnvironment()).resolves.toBe(true);
    api.mockResolvedValueOnce({ demo: false });
    await expect(mod.fetchIsDemoEnvironment()).resolves.toBe(false);
    expect(api).toHaveBeenCalledTimes(2);
  });
});
