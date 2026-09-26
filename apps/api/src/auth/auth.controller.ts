import { Body, Controller, Header, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
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

const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

// Las respuestas de login, refresh y MFA llevan tokens, secretos TOTP o códigos de
// recuperación: ningún navegador ni proxy intermedio debe guardarlas en caché.
const NO_STORE: [string, string] = ['Cache-Control', 'no-store'];

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private mfa: MfaService) {}

  @Throttle(AUTH_THROTTLE)
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.auth.register(dto, meta(req));
    setAuthCookies(res, session);
    return { user: session.user, workspaceId: session.workspaceId, role: session.role };
  }

  @Throttle(AUTH_THROTTLE)
  @Header(...NO_STORE)
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto, meta(req));
    if (result.mfaRequired) {
      return { mfaRequired: true, pendingToken: result.pendingToken };
    }
    setAuthCookies(res, result);
    return { mfaRequired: false, user: result.user, workspaceId: result.workspaceId, role: result.role };
  }

  @Throttle(AUTH_THROTTLE)
  @Header(...NO_STORE)
  @HttpCode(200)
  @Post('login/mfa')
  async loginMfa(@Body() dto: VerifyMfaLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.auth.verifyMfaLogin(dto.pendingToken, dto.code, meta(req));
    setAuthCookies(res, session);
    return { mfaRequired: false, user: session.user, workspaceId: session.workspaceId, role: session.role };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header(...NO_STORE)
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

  @Throttle(AUTH_THROTTLE)
  @Header(...NO_STORE)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Post('mfa/setup')
  async setupMfa(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.mfa.setupMfa({ userId: user.sub, workspaceId: user.workspaceId }, meta(req));
  }

  @Throttle(AUTH_THROTTLE)
  @Header(...NO_STORE)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Post('mfa/confirm')
  async confirmMfaSetup(@CurrentUser() user: AuthUser, @Body() dto: ConfirmMfaSetupDto, @Req() req: Request) {
    return this.mfa.confirmMfaSetup({ userId: user.sub, workspaceId: user.workspaceId }, dto.code, meta(req));
  }

  @Throttle(AUTH_THROTTLE)
  @Header(...NO_STORE)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Post('mfa/disable')
  async disableMfa(@CurrentUser() user: AuthUser, @Body() dto: DisableMfaDto, @Req() req: Request) {
    return this.mfa.disableMfa({ userId: user.sub, workspaceId: user.workspaceId }, dto.password, dto.code, meta(req));
  }
}
