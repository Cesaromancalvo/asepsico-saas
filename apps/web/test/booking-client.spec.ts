import { describe, expect, it, jest } from '@jest/globals';

const api = jest.fn(async (_path: string, _init?: unknown) => ({ timeZone: 'Europe/Madrid', professionals: [{ id: 't1', name: 'Ana Ficticia', portalBookingEnabled: true, timeZone: 'Europe/Madrid' }] }));
jest.mock('../lib/api', () => ({ api: (path: string, init?: unknown) => api(path, init), ApiError: class extends Error {} }));

import { listProfessionals } from '../lib/booking-client';

describe('listProfessionals', () => {
  it('pide el listado de profesionales a la API, sin deducirlo de las citas', async () => {
    const result = await listProfessionals();
    expect(api).toHaveBeenCalledWith('/scheduling/professionals', undefined);
    expect(result.professionals.map((p) => p.id)).toEqual(['t1']);
  });
});
