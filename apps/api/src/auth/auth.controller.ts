import { Body, Controller, Get, Header, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto, RegisterMemberDto } from './dto/register.dto';
import { RegistrationService } from './registration.service';
import { PasswordService } from './password.service';
import { ChangePasswordDto } from './dto/change-password.dto';
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
  constructor(
    private auth: AuthService,
    private mfa: MfaService,
    private registration: RegistrationService,
    private passwords: PasswordService,
  ) {}

  // Registro CERRADO: solo con invitación de plataforma (npm run invites:create) y aceptando las
  // condiciones vigentes. Cualquier fallo de invitación → 400 REGISTRATION_NOT_ALLOWED (neutro).
  @Throttle(AUTH_THROTTLE)
  @Header(...NO_STORE)
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.registration.register(dto, meta(req));
    setAuthCookies(res, session);
    return { user: session.user, workspaceId: session.workspaceId, role: session.role };
  }

  // Alta de un miembro invitado por el OWNER (POST /workspace-members/invites). Misma respuesta neutra.
  @Throttle(AUTH_THROTTLE)
  @Header(...NO_STORE)
  @Post('register/member')
  async registerMember(@Body() dto: RegisterMemberDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.registration.registerMember(dto, meta(req));
    setAuthCookies(res, session);
    // privacyNotice: política de privacidad vigente que la web debe mostrar al miembro (art. 13 RGPD).
    return { user: session.user, workspaceId: session.workspaceId, role: session.role, privacyNotice: session.privacyNotice };
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

  // Datos no clínicos del propio usuario (nombre, rol, isClinician, consulta, MFA). Todos los roles.
  @Header(...NO_STORE)
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response, @CurrentUser() user: AuthUser) {
    const rawToken = req.cookies?.[REFRESH_COOKIE];
    await this.auth.logout(rawToken, user);
    clearAuthCookies(res);
    return { success: true };
  }

  // Cambio de contraseña del propio profesional (todos los roles de personal). Pide la actual y,
  // con MFA activo, un TOTP. Revoca todas las demás sesiones y renueva la de este navegador.
  @Throttle(AUTH_THROTTLE)
  @Header(...NO_STORE)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @HttpCode(200)
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.passwords.changePassword({ userId: user.sub, workspaceId: user.workspaceId }, dto, meta(req));
    setAuthCookies(res, session);
    return { success: true, otherSessionsClosed: true };
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
  async confirmMfaSetup(
    @CurrentUser() user: AuthUser,
    @Body() dto: ConfirmMfaSetupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Activar el MFA cierra todas las sesiones (tokenVersion + refresh tokens revocados, en
    // MfaService). Esta petición ya verificó contraseña + TOTP: equivale a un login con segundo
    // factor, así que el navegador que lo activa recibe una sesión nueva con mfaEnabled=true.
    const result = await this.mfa.confirmMfaSetup({ userId: user.sub, workspaceId: user.workspaceId }, dto.password, dto.code, meta(req));
    const session = await this.auth.issueSession(result.sessionUser, user.workspaceId, result.role, meta(req));
    setAuthCookies(res, session);
    return { recoveryCodes: result.recoveryCodes };
  }

  @Throttle(AUTH_THROTTLE)
  @Header(...NO_STORE)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Post('mfa/disable')
  async disableMfa(@CurrentUser() user: AuthUser, @Body() dto: DisableMfaDto, @Req() req: Request) {
    return this.mfa.disableMfa({ userId: user.sub, workspaceId: user.workspaceId }, dto.password, dto.code, meta(req));
  }
}
