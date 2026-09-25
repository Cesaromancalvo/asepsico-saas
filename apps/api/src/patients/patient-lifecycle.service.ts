import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PatientStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { AssignableStatus } from './dto/change-status.dto';
import { PatientCoreService } from './patient-core.service';
import { decryptPatient } from './patient-crypto.util';
import { NON_MODIFIABLE_STATUSES, updatePatientScoped } from './patient-write.util';

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
 *
 * Todas las escrituras: (1) filtran por { id, workspaceId } — nunca solo por id —,
 * (2) incluyen en el where el estado validado (compare-and-set: si cambió entre la lectura y
 * la escritura → 409, sin escribir) y (3) se hacen en la misma $transaction que su
 * auditLog.create, de modo que si la auditoría falla el cambio no se confirma
 * (docs/SECURITY_BASELINE.md, auditoría transaccional).
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

    return this.prisma.$transaction(async (tx) => {
      const updated = await updatePatientScoped(tx, workspaceId, id, { status: patient.status }, {
        status: target,
      });

      await tx.auditLog.create({
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
    });
  }

  async archive(
    workspaceId: string,
    actor: AuthUser,
    id: string,
  ) {
    await this.core.assertActive(workspaceId, actor, id);

    return this.prisma.$transaction(async (tx) => {
      // assertActive ya rechaza ARCHIVED y BLOCKED; el guard lo repite en el UPDATE por si el
      // estado cambió entretanto (p. ej. un OWNER bloquea mientras otro usuario archiva).
      await updatePatientScoped(
        tx,
        workspaceId,
        id,
        { status: { notIn: [...NON_MODIFIABLE_STATUSES] } },
        { status: 'ARCHIVED', deletedAt: new Date() },
      );

      await tx.auditLog.create({
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
    });
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

    // Defensa en profundidad: un paciente que llegó a estar bloqueado (blockedAt) nunca vuelve a
    // ACTIVE por la vía de restaurar; desbloquear no es una operación normal (art. 32 LOPDGDD).
    if (patient.blockedAt) {
      throw new BadRequestException(
        'El paciente tiene los datos bloqueados y no puede restaurarse',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const restored = await updatePatientScoped(tx, workspaceId, id, { status: 'ARCHIVED', blockedAt: null }, {
        status: 'ACTIVE',
        deletedAt: null,
      });

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'PATIENT_RESTORED',
          entityType: 'Patient',
          entityId: id,
        },
      });

      return decryptPatient(restored);
    });
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

    return this.prisma.$transaction(async (tx) => {
      const updated = await updatePatientScoped(tx, workspaceId, id, { status: { not: PatientStatus.BLOCKED } }, {
        status: PatientStatus.BLOCKED,
        blockedAt,
        retentionUntil,
      });

      await tx.auditLog.create({
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
    });
  }

}
