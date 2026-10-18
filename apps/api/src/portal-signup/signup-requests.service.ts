import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { decryptModel, encryptModelData } from '../common/crypto/clinical-crypto';
import { isClinicalProfile } from '../clinical-access/clinical-access.service';
import { assertNoActiveDemoMembers } from '../patients/demo-workspace.util';
import { accessModesAllowing, isAccessorAllowed, isPatientPortalOpen, PORTAL_CLOSED_PATIENT_STATUSES } from '../portal/portal-access-mode.util';
import { LinkSignupRequestDto, SubmitSignupRequestDto } from './dto/portal-signup.dto';
import { PortalActivationService } from './portal-activation.service';
import {
  ageInYears, hashToken, isoDay, MAX_PENDING_REQUESTS_PER_PROFESSIONAL, MAX_REQUESTS_PER_LINK_PER_HOUR, MIN_SIGNUP_AGE_YEARS,
  normalizeName, SIGNUP_ACCEPTED_RESPONSE, SIGNUP_REQUEST_TTL_MS,
} from './portal-signup.config';

type Tx = Prisma.TransactionClient;
type DecryptedRequest = {
  id: string; workspaceId: string; intakeLinkId: string; professionalId: string;
  firstName: string; lastName: string; email: string; phone: string | null; birthDate: string;
  privacyNoticeVersion: string; portalTermsVersion: string; acknowledgedAt: Date; createdAt: Date; expiresAt: Date;
};

/** Mismo texto que la activación manual: no revela que el correo es de otro paciente u otra consulta. */
const EMAIL_UNAVAILABLE = 'Ese correo no puede usarse para esta cuenta de portal; indica otro correo';

/** Motivos de rechazo al vincular (lista cerrada, van a la auditoría sin datos personales). */
type LinkRejection = 'PATIENT_CLOSED' | 'ACCESS_MODE_NOT_ALLOWED' | 'PATIENT_UNDER_16_OR_NO_BIRTHDATE' | 'IDENTITY_MISMATCH' | 'PATIENT_ALREADY_HAS_ACCOUNT' | 'EMAIL_UNAVAILABLE';

/**
 * Solicitudes de alta en el portal hechas desde el QR fijo de un profesional.
 *
 *  - El envío público responde SIEMPRE lo mismo (token válido, inválido, rotado, desactivado o
 *    solicitud descartada por límites): no permite enumerar profesionales ni consultas.
 *  - La solicitud queda PENDIENTE, cifrada y sin acceso a nada. Solo existe mientras está
 *    pendiente: aceptar, rechazar o caducar (14 días) la BORRA; queda solo la auditoría.
 *  - Revisan: el profesional destinatario (solo las suyas), OWNER/ADMIN y ASSISTANT (todas las
 *    del workspace; Lex Psi P7: acto administrativo, la recepción comprueba la identidad en persona).
 *  - Solo al aceptar se crea la cuenta del portal, inactiva hasta que el paciente pone su contraseña
 *    con el enlace de activación (PortalActivationService).
 */
@Injectable()
export class SignupRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ público
  async submit(dto: SubmitSignupRequestDto) {
    const now = new Date();
    // Regla de edad ANTES de mirar el token: la respuesta no depende de si el token es válido.
    if (ageInYears(dto.birthDate, now) < MIN_SIGNUP_AGE_YEARS) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PORTAL_SIGNUP_MIN_AGE',
        message: 'Con menos de 16 años el alta la hace tu consulta contigo y con tu madre, padre o tutor.',
      });
    }

    const link = await this.prisma.portalIntakeLink.findFirst({
      where: { tokenHash: hashToken(dto.token), isActive: true },
      select: { id: true, workspaceId: true, professionalId: true },
    });
    if (!link) return SIGNUP_ACCEPTED_RESPONSE;

    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: link.workspaceId, userId: link.professionalId },
      select: { role: true, isClinician: true },
    });
    if (!member || !isClinicalProfile({ role: member.role, isClinician: member.isClinician === true })) return SIGNUP_ACCEPTED_RESPONSE;

    const { workspaceId, professionalId } = link;
    await this.prisma.$transaction(async (tx) => {
      // Serializa los envíos de un mismo QR: los límites se cuentan sin carreras.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portal-signup:${link.id}`}, 0))`;
      await this.purgeExpiredIn(tx, now, workspaceId);

      const pending = await tx.portalSignupRequest.count({ where: { workspaceId, professionalId, expiresAt: { gt: now } } });
      const lastHour = await tx.auditLog.count({
        where: { workspaceId, entityType: 'PortalIntakeLink', entityId: link.id, action: 'PORTAL_SIGNUP_REQUEST_CREATED', createdAt: { gt: new Date(now.getTime() - 60 * 60_000) } },
      });
      const dropReason = pending >= MAX_PENDING_REQUESTS_PER_PROFESSIONAL ? 'PENDING_LIMIT' : lastHour >= MAX_REQUESTS_PER_LINK_PER_HOUR ? 'LINK_HOURLY_LIMIT' : null;
      if (dropReason) {
        await tx.auditLog.create({
          data: { workspaceId, actorId: null, action: 'PORTAL_SIGNUP_REQUEST_DROPPED', entityType: 'PortalIntakeLink', entityId: link.id, metadata: { professionalId, reason: dropReason } },
        });
        return;
      }

      const request = await tx.portalSignupRequest.create({
        data: encryptModelData('portalSignupRequest', {
          workspaceId,
          intakeLinkId: link.id,
          professionalId,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          email: dto.email.trim().toLowerCase(),
          phone: dto.phone?.trim() || null,
          birthDate: dto.birthDate,
          privacyNoticeVersion: dto.privacyNoticeVersion,
          portalTermsVersion: dto.portalTermsVersion,
          acknowledgedAt: now,
          expiresAt: new Date(now.getTime() + SIGNUP_REQUEST_TTL_MS),
        }),
        select: { id: true },
      });
      await tx.auditLog.create({
        data: { workspaceId, actorId: null, action: 'PORTAL_SIGNUP_REQUEST_CREATED', entityType: 'PortalIntakeLink', entityId: link.id, metadata: { professionalId, requestId: request.id } },
      });
    });
    return SIGNUP_ACCEPTED_RESPONSE;
  }

  // ------------------------------------------------------------------ bandeja
  async list(workspaceId: string, actor: AuthUser, professionalId?: string) {
    this.assertReviewer(actor);
    const now = new Date();
    await this.prisma.$transaction((tx) => this.purgeExpiredIn(tx, now, workspaceId));
    const scope = actor.role === 'THERAPIST' ? { professionalId: actor.sub } : professionalId ? { professionalId } : {};
    const rows = await this.prisma.portalSignupRequest.findMany({
      where: { workspaceId, expiresAt: { gt: now }, ...scope },
      orderBy: { createdAt: 'asc' },
      select: { id: true, professionalId: true, firstName: true, lastName: true, email: true, phone: true, birthDate: true, createdAt: true, expiresAt: true },
    });
    return rows.map((row) => decryptModel('portalSignupRequest', row));
  }

  async reject(workspaceId: string, actor: AuthUser, requestId: string) {
    const request = await this.loadForDecision(workspaceId, actor, requestId);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.portalSignupRequest.deleteMany({ where: { id: request.id, workspaceId } });
      if (!count) throw new ConflictException('La solicitud ya se ha resuelto');
      await tx.auditLog.create({
        data: {
          workspaceId, actorId: actor.sub, action: 'PORTAL_SIGNUP_REQUEST_REJECTED', entityType: 'PortalSignupRequest', entityId: request.id,
          metadata: { professionalId: request.professionalId, intakeLinkId: request.intakeLinkId },
        },
      });
    });
    return { ok: true };
  }

  /** Aceptar vinculando a un paciente existente: nombre, apellidos y fecha de nacimiento deben coincidir. */
  async acceptLinkingPatient(workspaceId: string, actor: AuthUser, requestId: string, dto: LinkSignupRequestDto) {
    const request = await this.loadForDecision(workspaceId, actor, requestId);
    const patient = await this.prisma.patient.findFirst({
      where: { id: dto.patientId, workspaceId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, birthDate: true, status: true, portalAccessMode: true },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    if (actor.role === 'THERAPIST') {
      const treats = await this.prisma.clinicalProcess.findFirst({ where: { workspaceId, patientId: patient.id, therapistId: actor.sub }, select: { id: true } });
      if (!treats) throw new NotFoundException('Paciente no encontrado');
    }

    const reject = async (reason: LinkRejection, error: Error): Promise<never> => {
      await this.prisma.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action: 'PORTAL_SIGNUP_REQUEST_LINK_REJECTED', entityType: 'PortalSignupRequest', entityId: request.id, metadata: { patientId: patient.id, reason } },
      });
      throw error;
    };

    if (!isPatientPortalOpen(patient.status)) {
      return reject('PATIENT_CLOSED', new BadRequestException('No se puede habilitar el portal de un paciente archivado o con los datos bloqueados'));
    }
    if (!isAccessorAllowed(patient.portalAccessMode, 'PATIENT')) {
      return reject('ACCESS_MODE_NOT_ALLOWED', new BadRequestException('El modo de acceso al portal de este paciente no admite cuenta del propio paciente'));
    }
    const patientBirth = isoDay(patient.birthDate);
    if (!patientBirth || ageInYears(patientBirth) < MIN_SIGNUP_AGE_YEARS) {
      return reject('PATIENT_UNDER_16_OR_NO_BIRTHDATE', new BadRequestException({
        statusCode: 400, code: 'PORTAL_SIGNUP_MANUAL_WITH_GUARDIAN', message: 'Este paciente no admite alta por QR: activa el portal manualmente con su tutor.',
      }));
    }
    const sameIdentity = normalizeName(patient.firstName) === normalizeName(request.firstName)
      && normalizeName(patient.lastName) === normalizeName(request.lastName)
      && patientBirth === request.birthDate;
    if (!sameIdentity) {
      return reject('IDENTITY_MISMATCH', new ConflictException({
        statusCode: 409, code: 'PORTAL_SIGNUP_IDENTITY_MISMATCH',
        message: 'El nombre, los apellidos o la fecha de nacimiento de la solicitud no coinciden con la ficha. Revísalos con el paciente o crea un paciente nuevo.',
      }));
    }
    const liveAccount = await this.prisma.patientPortalAccount.findFirst({
      where: { workspaceId, patientId: patient.id, accessorType: 'PATIENT', OR: [{ isActive: true }, { pendingActivation: true }] },
      select: { id: true },
    });
    if (liveAccount) {
      return reject('PATIENT_ALREADY_HAS_ACCOUNT', new ConflictException({
        statusCode: 409, code: 'PORTAL_ACCOUNT_ALREADY_EXISTS', message: 'Este paciente ya tiene cuenta de portal (o una pendiente de activar). Rechaza la solicitud.',
      }));
    }
    if (await this.emailTaken(request.email)) return reject('EMAIL_UNAVAILABLE', new BadRequestException(EMAIL_UNAVAILABLE));

    return this.withEmailRace(() => this.prisma.$transaction((tx) => this.finalize(tx, actor, request, patient.id, 'LINKED')));
  }

  /** Aceptar creando un paciente nuevo con los datos de la solicitud. */
  async acceptCreatingPatient(workspaceId: string, actor: AuthUser, requestId: string) {
    const request = await this.loadForDecision(workspaceId, actor, requestId);
    if (await this.emailTaken(request.email)) throw new BadRequestException(EMAIL_UNAVAILABLE);

    return this.withEmailRace(() => this.prisma.$transaction(async (tx) => {
      await assertNoActiveDemoMembers(tx, workspaceId);
      const patient = await tx.patient.create({
        data: {
          workspaceId,
          firstName: request.firstName,
          lastName: request.lastName,
          email: request.email,
          phone: request.phone,
          birthDate: new Date(`${request.birthDate}T00:00:00.000Z`),
          portalAccessMode: 'PATIENT_ONLY',
        },
        select: { id: true, portalAccessMode: true },
      });
      await tx.auditLog.create({
        data: {
          workspaceId, actorId: actor.sub, action: 'PATIENT_CREATED', entityType: 'Patient', entityId: patient.id,
          metadata: { portalAccessMode: patient.portalAccessMode, origin: 'QR_SIGNUP', signupRequestId: request.id },
        },
      });
      return this.finalize(tx, actor, request, patient.id, 'CREATED');
    }));
  }

  // ------------------------------------------------------------------ caducidad
  /** Borra las solicitudes caducadas (de un workspace o de todos) y audita cada una, sin datos personales. */
  async purgeExpired(now: Date = new Date()) {
    return this.prisma.$transaction((tx) => this.purgeExpiredIn(tx, now));
  }

  private async purgeExpiredIn(tx: Tx, now: Date, workspaceId?: string): Promise<number> {
    const expired = await tx.portalSignupRequest.findMany({
      where: { expiresAt: { lte: now }, ...(workspaceId ? { workspaceId } : {}) },
      select: { id: true, workspaceId: true, professionalId: true },
    });
    if (!expired.length) return 0;
    for (const row of expired) {
      await tx.portalSignupRequest.deleteMany({ where: { id: row.id, workspaceId: row.workspaceId } });
    }
    await tx.auditLog.createMany({
      data: expired.map((row) => ({
        workspaceId: row.workspaceId, actorId: null, action: 'PORTAL_SIGNUP_REQUEST_EXPIRED', entityType: 'PortalSignupRequest', entityId: row.id,
        metadata: { professionalId: row.professionalId },
      })),
    });
    return expired.length;
  }

  // ------------------------------------------------------------------ internos
  private assertReviewer(actor: AuthUser) {
    assertStaffRole(actor);
    if (!['OWNER', 'ADMIN', 'ASSISTANT', 'THERAPIST'].includes(actor.role)) throw new ForbiddenException('No autorizado');
  }

  /** Solicitud viva del workspace que el actor puede resolver (THERAPIST: solo las suyas). Si no, 404. */
  private async loadForDecision(workspaceId: string, actor: AuthUser, requestId: string): Promise<DecryptedRequest> {
    this.assertReviewer(actor);
    const row = await this.prisma.portalSignupRequest.findFirst({ where: { id: requestId, workspaceId, expiresAt: { gt: new Date() } } });
    if (!row || (actor.role === 'THERAPIST' && row.professionalId !== actor.sub)) throw new NotFoundException('Solicitud no encontrada');
    const request = decryptModel('portalSignupRequest', row) as unknown as DecryptedRequest;
    // Defensa: el envío ya lo exige, pero la regla se repite al aceptar (la fecha no cambia; la ley sí podría).
    if (ageInYears(request.birthDate) < MIN_SIGNUP_AGE_YEARS) throw new BadRequestException({ statusCode: 400, code: 'PORTAL_SIGNUP_MANUAL_WITH_GUARDIAN', message: 'Alta por QR no permitida para menores de 16 años.' });
    return request;
  }

  private async emailTaken(email: string) {
    return Boolean(await this.prisma.patientPortalAccount.findFirst({ where: { email: email.toLowerCase().trim() }, select: { id: true } }));
  }

  private async withEmailRace<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new BadRequestException(EMAIL_UNAVAILABLE);
      throw error;
    }
  }

  /** Dentro de la transacción: consume la solicitud, crea la cuenta pendiente y el enlace de activación, y audita. */
  private async finalize(tx: Tx, actor: AuthUser, request: DecryptedRequest, patientId: string, mode: 'LINKED' | 'CREATED') {
    const { workspaceId } = request;
    const now = new Date();
    // Compare-and-set sobre el paciente, como la activación manual.
    const { count: patientOk } = await tx.patient.updateMany({
      where: { id: patientId, workspaceId, deletedAt: null, status: { notIn: [...PORTAL_CLOSED_PATIENT_STATUSES] }, portalAccessMode: { in: accessModesAllowing('PATIENT') } },
      data: { updatedAt: now },
    });
    if (!patientOk) throw new ConflictException('El estado del paciente ha cambiado; recarga y vuelve a intentarlo');

    // Consumo de la solicitud: si otra persona la resolvió a la vez, count 0 → 409 y nada se confirma.
    const { count: consumed } = await tx.portalSignupRequest.deleteMany({ where: { id: request.id, workspaceId, expiresAt: { gt: now } } });
    if (!consumed) throw new ConflictException('La solicitud ya se ha resuelto o ha caducado');

    // Contraseña aleatoria que nadie conoce: la cuenta no sirve hasta canjear el enlace de activación.
    const unusableHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 10);
    const account = await tx.patientPortalAccount.create({
      data: {
        workspaceId, patientId, email: request.email.toLowerCase().trim(), passwordHash: unusableHash, accessorType: 'PATIENT',
        isActive: false, pendingActivation: true, mustChangePassword: false,
        privacyNoticeVersion: request.privacyNoticeVersion, privacyNoticeAcknowledgedAt: request.acknowledgedAt,
        portalTermsVersion: request.portalTermsVersion, portalTermsAcceptedAt: request.acknowledgedAt,
      },
      select: { id: true },
    });
    const activation = await PortalActivationService.issue(tx, { workspaceId, patientId, portalAccountId: account.id, actorId: actor.sub });

    await tx.auditLog.create({
      data: {
        workspaceId, actorId: actor.sub, action: 'PORTAL_ACCOUNT_ENABLED', entityType: 'PatientPortalAccount', entityId: account.id,
        metadata: { patientId, accessorType: 'PATIENT', origin: 'QR_SIGNUP', signupRequestId: request.id, professionalId: request.professionalId },
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId, actorId: actor.sub, action: 'PORTAL_SIGNUP_REQUEST_ACCEPTED', entityType: 'PortalSignupRequest', entityId: request.id,
        metadata: { mode, patientId, professionalId: request.professionalId, intakeLinkId: request.intakeLinkId, activationTokenId: activation.activationTokenId },
      },
    });
    return { patientId, portalAccountId: account.id, activation: { token: activation.token, expiresAt: activation.expiresAt } };
  }
}
