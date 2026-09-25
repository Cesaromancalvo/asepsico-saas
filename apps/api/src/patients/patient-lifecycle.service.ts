import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PatientStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { AssignableStatus } from './dto/change-status.dto';
import { PatientCoreService } from './patient-core.service';
import { decryptPatient } from './patient-crypto.util';

const ALLOWED_TRANSITIONS: Record<PatientStatus, AssignableStatus[]> = {
  ACTIVE: ['PAUSED', 'DISCHARGED'],
  PAUSED: ['ACTIVE', 'DISCHARGED'],
  DISCHARGED: ['ACTIVE'],
  ARCHIVED: [],
  // Bloqueado no admite transiciones normales: es un estado de salida, previo al borrado
  // definitivo al cumplirse el plazo legal de conservación. Se llega a él únicamente a
  // través de block(), nunca del selector de estados habitual.
  BLOCKED: [],
};

// Años mínimos de conservación de la historia clínica antes de poder suprimirla de verdad
// (Ley 41/2002, mínimo estatal; algunas comunidades autónomas exigen más — confirmar con
// el despacho si el volumen de pacientes crece fuera de la Comunidad Valenciana).
const RETENTION_YEARS = 5;

/**
 * Ciclo de vida del paciente: cambio de estado, archivado, restauración y bloqueo.
 * Se apoya en PatientCoreService para las lecturas con control de acceso (get/assertActive).
 */
@Injectable()
export class PatientLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PatientCoreService,
  ) {}

  async changeStatus(
    workspaceId: string,
    actor: AuthUser,
    id: string,
    target: AssignableStatus,
  ) {
    const patient = await this.core.get(
      workspaceId,
      actor,
      id,
    );

    if (patient.status === target) {
      return patient;
    }

    const allowed =
      ALLOWED_TRANSITIONS[patient.status] ?? [];

    if (!allowed.includes(target)) {
      throw new BadRequestException(
        `No se puede pasar de ${patient.status} a ${target}`,
      );
    }

    const updated =
      await this.prisma.patient.update({
        where: {
          id,
        },
        data: {
          status: target,
        },
      });

    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: actor.sub,
        action: 'PATIENT_STATUS_CHANGED',
        entityType: 'Patient',
        entityId: id,
        metadata: {
          from: patient.status,
          to: target,
        },
      },
    });

    return decryptPatient(updated);
  }

  async archive(
    workspaceId: string,
    actor: AuthUser,
    id: string,
  ) {
    await this.core.assertActive(workspaceId, actor, id);

    const { count } =
      await this.prisma.patient.updateMany({
        where: {
          id,
          workspaceId,
        },
        data: {
          status: 'ARCHIVED',
          deletedAt: new Date(),
        },
      });

    if (count === 0) {
      throw new NotFoundException(
        'Paciente no encontrado',
      );
    }

    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: actor.sub,
        action: 'PATIENT_ARCHIVED',
        entityType: 'Patient',
        entityId: id,
      },
    });

    return {
      success: true,
    };
  }

  async restore(
    workspaceId: string,
    actor: AuthUser,
    id: string,
  ) {
    const patient = await this.core.get(
      workspaceId,
      actor,
      id,
    );

    if (patient.status !== 'ARCHIVED') {
      throw new BadRequestException(
        'El paciente no está archivado',
      );
    }

    const restored =
      await this.prisma.patient.update({
        where: {
          id,
        },
        data: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      });

    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: actor.sub,
        action: 'PATIENT_RESTORED',
        entityType: 'Patient',
        entityId: id,
      },
    });

    return decryptPatient(restored);
  }

  /**
   * Bloquea los datos de un paciente (art. 32 LOPDGDD): cuando se solicita la baja o el
   * borrado pero existe obligación legal de conservar la historia clínica (mínimo 5 años,
   * Ley 41/2002), los datos no se suprimen de inmediato — se bloquean, quedando fuera de
   * cualquier uso operativo normal (ya no aparecen en list() por defecto) y accesibles solo
   * de forma explícita, para defensa legal. Pasado el plazo (retentionUntil), el borrado
   * definitivo es una acción manual separada, no automática.
   *
   * Solo OWNER/ADMIN pueden bloquear: es una decisión administrativa/legal, no clínica del
   * día a día, y no puede deshacerse desde aquí — no existe un "unblock" normal.
   */
  async block(workspaceId: string, actor: AuthUser, id: string) {
    if (!['OWNER', 'ADMIN'].includes(actor.role)) {
      throw new ForbiddenException('Solo el propietario o un administrador pueden bloquear los datos de un paciente');
    }

    const patient = await this.prisma.patient.findFirst({ where: { id, workspaceId } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    if (patient.status === PatientStatus.BLOCKED) {
      throw new BadRequestException('El paciente ya está bloqueado');
    }

    const blockedAt = new Date();
    const retentionUntil = new Date(blockedAt);
    retentionUntil.setFullYear(retentionUntil.getFullYear() + RETENTION_YEARS);

    const updated = await this.prisma.patient.update({
      where: { id },
      data: { status: PatientStatus.BLOCKED, blockedAt, retentionUntil },
    });

    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: actor.sub,
        action: 'PATIENT_BLOCKED',
        entityType: 'Patient',
        entityId: id,
        metadata: { previousStatus: patient.status, retentionUntil: retentionUntil.toISOString() },
      },
    });

    return decryptPatient(updated);
  }
}
