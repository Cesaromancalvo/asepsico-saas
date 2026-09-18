import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { VerifyMfaLoginDto, ConfirmMfaSetupDto, DisableMfaDto } from './dto/mfa.dto';
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from './cookie.util';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

function meta(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

// Límites deliberadamente estrictos: login/registro son los endpoints más atacados
// (credential stuffing, cuentas duplicadas). 5 intentos por minuto por IP.
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Throttle(AUTH_THROTTLE)
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.auth.register(dto, meta(req));
    setAuthCookies(res, session);
    return { user: session.user, workspaceId: session.workspaceId, role: session.role };
  }

  @Throttle(AUTH_THROTTLE)
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto, meta(req));
    if (result.mfaRequired) {
      // Sin cookies todavía: la sesión de verdad no se emite hasta que se verifique el
      // segundo factor en /auth/login/mfa.
      return { mfaRequired: true, pendingToken: result.pendingToken };
    }
    setAuthCookies(res, result);
    return { mfaRequired: false, user: result.user, workspaceId: result.workspaceId, role: result.role };
  }

  // Mismo límite que el login normal: un código de 6 dígitos es fuerza-bruteable si no se
  // limitan los intentos (1 millón de combinaciones, pero cada código solo vale 30s).
  @Throttle(AUTH_THROTTLE)
  @HttpCode(200)
  @Post('login/mfa')
  async loginMfa(@Body() dto: VerifyMfaLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.auth.verifyMfaLogin(dto.pendingToken, dto.code, meta(req));
    setAuthCookies(res, session);
    return { mfaRequired: false, user: session.user, workspaceId: session.workspaceId, role: session.role };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawToken = req.cookies?.[REFRESH_COOKIE];
    const session = await this.auth.refresh(rawToken, meta(req));
    setAuthCookies(res, session);
    return { user: session.user, workspaceId: session.workspaceId, role: session.role };
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response, @CurrentUser() _user: AuthUser) {
    const rawToken = req.cookies?.[REFRESH_COOKIE];
    await this.auth.logout(rawToken);
    clearAuthCookies(res);
    return { success: true };
  }

  // --- MFA: solo para una sesión ya iniciada (activar/desactivar el segundo factor propio) ---

  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Post('mfa/setup')
  async setupMfa(@CurrentUser() user: AuthUser) {
    return this.auth.setupMfa(user.sub);
  }

  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Post('mfa/confirm')
  async confirmMfaSetup(@CurrentUser() user: AuthUser, @Body() dto: ConfirmMfaSetupDto) {
    return this.auth.confirmMfaSetup(user.sub, dto.code);
  }

  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Post('mfa/disable')
  async disableMfa(@CurrentUser() user: AuthUser, @Body() dto: DisableMfaDto) {
    return this.auth.disableMfa(user.sub, dto.password, dto.code);
  }
}
