import { Body, Controller, ForbiddenException, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { PrismaService } from '../database/prisma.service';
import { LogExceptionalAccessDto } from './dto/exceptional-access.dto';

/**
 * Cláusula 3.3 del contrato de encargo del tratamiento: el Encargado (nosotros) no accede
 * al contenido clínico de los pacientes salvo para resolver una incidencia, por necesidad
 * técnica imprescindible, o por obligación legal — y cada acceso de ese tipo debe quedar
 * registrado con su motivo. Este endpoint es ese registro: no bloquea nada (OWNER/ADMIN ya
 * tienen acceso completo por diseño), pero exige documentar explícitamente el porqué,
 * distinto del registro de auditoría automático que ya existe para el resto de acciones.
 */
@ApiTags('exceptional-access')
@Controller('patients')
@UseGuards(JwtAuthGuard, CsrfGuard)
export class ExceptionalAccessController {
  constructor(private readonly prisma: PrismaService) {}

  @Post(':patientId/exceptional-access')
  async log(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string, @Body() dto: LogExceptionalAccessDto) {
    if (!['OWNER', 'ADMIN'].includes(user.role)) {
      throw new ForbiddenException('Solo propietarios y administradores pueden registrar un acceso excepcional');
    }
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, workspaceId: user.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');

    await this.prisma.auditLog.create({
      data: {
        workspaceId: user.workspaceId,
        actorId: user.sub,
        action: 'EXCEPTIONAL_CLINICAL_ACCESS',
        entityType: 'Patient',
        entityId: patientId,
        metadata: { reason: dto.reason, role: user.role },
      },
    });
    return { ok: true };
  }
}
