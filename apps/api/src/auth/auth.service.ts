import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { generateOpaqueToken, hashToken } from './token.util';
import { randomUUID } from 'crypto';

const REFRESH_TOKEN_TTL_DAYS = 7;

export type IssuedSession = {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: { id: string; email: string; firstName: string; lastName: string };
  workspaceId: string;
  role: string;
};

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}

  async register(dto: RegisterDto, meta: { ip?: string; userAgent?: string }) {
    if (await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } })) {
      throw new BadRequestException('El correo ya está registrado');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: dto.email.toLowerCase(), passwordHash: await hash(dto.password, 12), firstName: dto.firstName, lastName: dto.lastName },
      });
      const workspace = await tx.workspace.create({ data: { name: dto.workspaceName } });
      const membership = await tx.workspaceMember.create({ data: { userId: user.id, workspaceId: workspace.id, role: 'OWNER' } });
      return { user, workspace, membership };
    });
    return this.issueSession(result.user, result.workspace.id, result.membership.role, meta);
  }

  async login(dto: LoginDto, meta: { ip?: string; userAgent?: string }) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() }, include: { memberships: { take: 1 } } });
    // Comparación constante-en-tiempo incluso si el usuario no existe, para no filtrar por timing qué correos están registrados.
    const passwordHash = user?.passwordHash ?? '$2a$12$invalidinvalidinvaliduinvalidinvalidinvalidinvalidinva';
    const passwordOk = await compare(dto.password, passwordHash);
    if (!user || !passwordOk || !user.memberships[0]) throw new UnauthorizedException('Credenciales incorrectas');
    return this.issueSession(user, user.memberships[0].workspaceId, user.memberships[0].role, meta);
  }

  /**
   * Rota el refresh token. Si el token presentado ya estaba revocado, se interpreta como
   * reutilización de un token robado/filtrado: se revoca toda la familia de tokens del usuario
   * (todas las sesiones derivadas del mismo login) y se fuerza a re-autenticar.
   */
  async refresh(rawToken: string, meta: { ip?: string; userAgent?: string }): Promise<IssuedSession> {
    if (!rawToken) throw new UnauthorizedException('Sesión no válida');
    const tokenHash = hashToken(rawToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored) throw new UnauthorizedException('Sesión no válida');

    if (stored.revokedAt || stored.expiresAt < new Date()) {
      if (stored.revokedAt) {
        await this.prisma.refreshToken.updateMany({
          where: { family: stored.family, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      throw new UnauthorizedException('Sesión no válida, vuelve a iniciar sesión');
    }

    // Reclama el token de forma atómica antes de emitir el siguiente. Así, dos peticiones
    // concurrentes con el mismo refresh token no pueden crear dos sesiones válidas.
    const claimedAt = new Date();
    const claim = await this.prisma.refreshToken.updateMany({
      where: {
        id: stored.id,
        revokedAt: null,
        expiresAt: { gt: claimedAt },
      },
      data: { revokedAt: claimedAt },
    });
    if (claim.count !== 1) {
      await this.prisma.refreshToken.updateMany({
        where: { family: stored.family, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Sesión no válida, vuelve a iniciar sesión');
    }

    const [user, membership] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: stored.userId } }),
      this.prisma.workspaceMember.findFirst({ where: { userId: stored.userId, workspaceId: stored.workspaceId } }),
    ]);
    if (!user || !membership) throw new UnauthorizedException('Sesión no válida');

    const session = await this.issueSession(user, stored.workspaceId, membership.role, meta, stored.family);
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { replacedBy: hashToken(session.refreshToken) },
    });
    return session;
  }

  async logout(rawToken?: string) {
    if (!rawToken) return { success: true };
    const tokenHash = hashToken(rawToken);
    await this.prisma.refreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } });
    return { success: true };
  }

  private async issueSession(
    user: { id: string; email: string; firstName: string; lastName: string },
    workspaceId: string,
    role: string,
    meta: { ip?: string; userAgent?: string },
    family?: string,
  ): Promise<IssuedSession> {
    const accessToken = await this.jwt.signAsync({ sub: user.id, email: user.email, workspaceId, role });
    const refreshToken = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        workspaceId,
        tokenHash: hashToken(refreshToken),
        family: family ?? randomUUID(),
        expiresAt,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      },
    });
    return {
      accessToken,
      refreshToken,
      refreshTokenExpiresAt: expiresAt,
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
      workspaceId,
      role,
    };
  }
}
