import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ActivatePortalAccountDto, BulkRejectSignupRequestsDto, LinkSignupRequestDto, SubmitSignupRequestDto } from './dto/portal-signup.dto';
import { PortalAccountEmailService } from './portal-account-email.service';
import { IntakeLinksService } from './intake-links.service';
import { PortalActivationService } from './portal-activation.service';
import { ACTIVATION_THROTTLE, SIGNUP_SUBMIT_THROTTLE } from './portal-signup.config';
import { SignupRequestsService } from './signup-requests.service';

/** Gestión del QR fijo del profesional y bandeja de solicitudes (personal de la consulta). */
@ApiTags('portal-signup')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class PortalSignupController {
  constructor(
    private readonly links: IntakeLinksService,
    private readonly requests: SignupRequestsService,
    private readonly activation: PortalActivationService,
    private readonly accountEmail: PortalAccountEmailService,
  ) {}

  /** :professionalId puede ser "me". El token solo se devuelve a quien gestiona ese QR. */
  @Get('portal-intake-links/:professionalId') @Header('Cache-Control', 'no-store')
  getLink(@CurrentUser() user: AuthUser, @Param('professionalId') professionalId: string) {
    return this.links.get(user.workspaceId, user, professionalId);
  }

  @Post('portal-intake-links/:professionalId/rotate') @UseGuards(CsrfGuard) @Header('Cache-Control', 'no-store')
  rotateLink(@CurrentUser() user: AuthUser, @Param('professionalId') professionalId: string) {
    return this.links.rotate(user.workspaceId, user, professionalId);
  }

  @Delete('portal-intake-links/:professionalId') @UseGuards(CsrfGuard)
  disableLink(@CurrentUser() user: AuthUser, @Param('professionalId') professionalId: string) {
    return this.links.disable(user.workspaceId, user, professionalId);
  }

  @Get('portal-signup-requests') @Header('Cache-Control', 'no-store')
  listRequests(@CurrentUser() user: AuthUser, @Query('professionalId') professionalId?: string) {
    return this.requests.list(user.workspaceId, user, typeof professionalId === 'string' ? professionalId : undefined);
  }

  @Post('portal-signup-requests/bulk-reject') @UseGuards(CsrfGuard)
  rejectMany(@CurrentUser() user: AuthUser, @Body() dto: BulkRejectSignupRequestsDto) {
    return this.requests.rejectMany(user.workspaceId, user, dto);
  }

  @Post('portal-signup-requests/:requestId/link') @UseGuards(CsrfGuard) @Header('Cache-Control', 'no-store')
  link(@CurrentUser() user: AuthUser, @Param('requestId') requestId: string, @Body() dto: LinkSignupRequestDto) {
    return this.requests.acceptLinkingPatient(user.workspaceId, user, requestId, dto);
  }

  @Post('portal-signup-requests/:requestId/create-patient') @UseGuards(CsrfGuard) @Header('Cache-Control', 'no-store')
  createPatient(@CurrentUser() user: AuthUser, @Param('requestId') requestId: string) {
    return this.requests.acceptCreatingPatient(user.workspaceId, user, requestId);
  }

  @Post('portal-signup-requests/:requestId/reject') @UseGuards(CsrfGuard)
  reject(@CurrentUser() user: AuthUser, @Param('requestId') requestId: string) {
    return this.requests.reject(user.workspaceId, user, requestId);
  }

  /** Libera un correo sin verificar de una cuenta ya desactivada (OWNER/ADMIN). Ver portal-email.util.ts. */
  @Post('patients/:patientId/portal-accounts/:accountId/release-email') @UseGuards(CsrfGuard)
  releaseEmail(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string, @Param('accountId') accountId: string) {
    return this.accountEmail.release(user.workspaceId, user, patientId, accountId);
  }

  /** Nuevo enlace de activación para una cuenta aún pendiente (revoca el anterior). */
  @Post('patients/:patientId/portal-account/activation-link') @UseGuards(CsrfGuard) @Header('Cache-Control', 'no-store')
  reissueActivation(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string) {
    return this.activation.reissue(user.workspaceId, user, patientId);
  }
}

/**
 * Endpoints PÚBLICOS (sin sesión ni cookies, por eso sin CsrfGuard). Límite por IP con el
 * ThrottlerGuard global. Sin caché ni referrer: el token no debe quedar en proxies ni salir a
 * terceros. Nunca se registra el cuerpo (ni token, ni datos personales).
 */
@ApiTags('public-portal-signup')
@Controller('public/portal-signup')
export class PublicPortalSignupController {
  constructor(
    private readonly requests: SignupRequestsService,
    private readonly activation: PortalActivationService,
  ) {}

  @Post('requests') @HttpCode(202) @Throttle(SIGNUP_SUBMIT_THROTTLE)
  @Header('Cache-Control', 'no-store') @Header('Referrer-Policy', 'no-referrer')
  submit(@Body() dto: SubmitSignupRequestDto) {
    return this.requests.submit(dto);
  }

  @Post('activate') @HttpCode(200) @Throttle(ACTIVATION_THROTTLE)
  @Header('Cache-Control', 'no-store') @Header('Referrer-Policy', 'no-referrer')
  activate(@Body() dto: ActivatePortalAccountDto) {
    return this.activation.redeem(dto);
  }
}
