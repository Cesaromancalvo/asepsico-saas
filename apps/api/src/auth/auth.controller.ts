import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from './cookie.util';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
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
    const session = await this.auth.login(dto, meta(req));
    setAuthCookies(res, session);
    return { user: session.user, workspaceId: session.workspaceId, role: session.role };
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
}
