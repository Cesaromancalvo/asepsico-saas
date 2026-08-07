import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { hashToken } from '../src/auth/token.util';

describe('AuthService refresh-token rotation', () => {
  it('solo permite que una petición concurrente reclame el refresh token', async () => {
    const stored = {
      id: 'rt-1', userId: 'user-1', workspaceId: 'ws-1', family: 'family-1',
      tokenHash: hashToken('raw-token'), expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
    };
    let claimed = false;
    const prisma: any = {
      refreshToken: {
        findUnique: jest.fn().mockResolvedValue(stored),
        updateMany: jest.fn(async ({ where }: any) => {
          if (where.id === stored.id) {
            if (claimed) return { count: 0 };
            claimed = true;
            return { count: 1 };
          }
          return { count: 1 };
        }),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ id:'user-1', email:'u@example.com', firstName:'U', lastName:'One' }) },
      workspaceMember: { findFirst: jest.fn().mockResolvedValue({ role:'OWNER' }) },
    };
    const jwt: any = { signAsync: jest.fn().mockResolvedValue('access') };
    const service = new AuthService(prisma, jwt);

    const results = await Promise.allSettled([
      service.refresh('raw-token', {}),
      service.refresh('raw-token', {}),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(UnauthorizedException);
  });
});
