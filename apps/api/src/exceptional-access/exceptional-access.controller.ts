import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ExceptionalAccessService } from './exceptional-access.service';
import { ExceptionalAccessRegisterService } from './exceptional-access-register.service';
import { CreateExceptionalAccessDto, ReadJustificationDto, ReviewDto } from './dto/exceptional-access.dto';

/**
 * Acceso excepcional a la historia clínica (docs/producto/acceso-excepcional.md). Los permisos
 * los deciden los servicios con el rol de la BD; aquí no hay lógica.
 */
@ApiTags('exceptional-access')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller()
export class ExceptionalAccessController {
  constructor(private readonly service: ExceptionalAccessService, private readonly register: ExceptionalAccessRegisterService) {}

  /** H1. OWNER/ADMIN (códigos según perfil clínico). THERAPIST/ASSISTANT 403. */
  @Post('patients/:patientId/exceptional-access')
  create(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string, @Body() dto: CreateExceptionalAccessDto) {
    return this.service.create(user.workspaceId, user, patientId, dto);
  }

  /** Banda de la ficha: acceso vigente en ESTA sesión y si puede pedirlo. Sin texto. */
  @Get('patients/:patientId/exceptional-access/current')
  current(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string) {
    return this.service.current(user.workspaceId, user, patientId);
  }

  /** [Cerrar acceso]: solo el propio. */
  @Post('patients/:patientId/exceptional-access/:accessId/close')
  @HttpCode(200)
  close(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string, @Param('accessId') accessId: string) {
    return this.service.close(user.workspaceId, user, patientId, accessId);
  }

  /** CA3.2: "Accesos de otras personas" (autores de procesos del paciente). */
  @Get('patients/:patientId/access-history')
  accessHistory(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string) {
    return this.register.patientAccessHistory(user.workspaceId, user, patientId);
  }

  /** CA1.11: contador agregado de "Mi motivo no está en la lista". OWNER/ADMIN. */
  @Post('exceptional-access/reason-miss')
  @HttpCode(200)
  reasonMiss(@CurrentUser() user: AuthUser) {
    return this.service.countReasonMiss(user.workspaceId, user);
  }

  /** H4: registro. OWNER todo; ADMIN lo suyo; resto 403. */
  @Get('exceptional-access')
  list(@CurrentUser() user: AuthUser) {
    return this.register.list(user.workspaceId, user);
  }

  /** CA4.2: leer la explicación (solo OWNER, motivo de lectura auditado). POST: CSRF. */
  @Post('exceptional-access/:accessId/justification')
  @HttpCode(200)
  readJustification(@CurrentUser() user: AuthUser, @Param('accessId') accessId: string, @Body() dto: ReadJustificationDto) {
    return this.register.readJustification(user.workspaceId, user, accessId, dto.purpose);
  }

  /** CA4.3–CA4.5: revisión de urgencias (solo OWNER). */
  @Post('exceptional-access/:accessId/review')
  @HttpCode(200)
  reviewAccess(@CurrentUser() user: AuthUser, @Param('accessId') accessId: string, @Body() dto: ReviewDto) {
    return this.register.reviewAccess(user.workspaceId, user, accessId, dto.outcome);
  }

  /** CA6.6: revisión de autoaperturas de proceso sobre historia ajena (solo OWNER). */
  @Post('exceptional-access/openings/:openingId/review')
  @HttpCode(200)
  reviewOpening(@CurrentUser() user: AuthUser, @Param('openingId') openingId: string, @Body() dto: ReviewDto) {
    return this.register.reviewOpening(user.workspaceId, user, openingId, dto.outcome);
  }

  /** CA3.4: liberar un aviso diferido (solo OWNER). */
  @Post('exceptional-access/:accessId/release-notice')
  @HttpCode(200)
  releaseNotice(@CurrentUser() user: AuthUser, @Param('accessId') accessId: string) {
    return this.register.releaseNotice(user.workspaceId, user, accessId);
  }
}
