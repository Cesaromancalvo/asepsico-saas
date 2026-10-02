import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { getCurrentLegalDocuments } from './legal-documents';
import { AcceptTermsDto } from './dto/accept-terms.dto';
import { assertAcceptsCurrentTerms, legalDocumentRef, pendingLegalDocuments, recordTermsAcceptances } from './terms-acceptance';

@Injectable()
export class LegalService {
  constructor(private readonly prisma: PrismaService) {}

  /** Textos vigentes (públicos: la pantalla de registro los enseña antes de iniciar sesión). */
  currentDocuments() {
    return getCurrentLegalDocuments().map((doc) => ({ ...legalDocumentRef(doc), text: doc.text }));
  }

  /** Estado para la sesión actual. Solo el OWNER puede (y debe) aceptar. */
  async status(actor: AuthUser) {
    assertStaffRole(actor);
    const [role, pending] = await Promise.all([
      this.actorRole(actor),
      pendingLegalDocuments(this.prisma, actor.workspaceId),
    ]);
    return {
      acceptanceRequired: pending.length > 0,
      canAccept: role === 'OWNER',
      pending: pending.map(legalDocumentRef),
    };
  }

  /** El OWNER (según la BD) acepta las versiones vigentes. Evidencia y auditoría en la misma transacción. */
  async accept(actor: AuthUser, dto: AcceptTermsDto, meta: { ip?: string; userAgent?: string }) {
    assertStaffRole(actor);
    if ((await this.actorRole(actor)) !== 'OWNER') {
      throw new ForbiddenException('Solo el titular de la consulta puede aceptar las condiciones');
    }
    assertAcceptsCurrentTerms(dto.acceptedTerms);
    try {
      await this.prisma.$transaction(async (tx) => {
        const pending = await pendingLegalDocuments(tx, actor.workspaceId);
        if (pending.length > 0) {
          await recordTermsAcceptances(tx, { workspaceId: actor.workspaceId, userId: actor.sub, docs: pending, meta });
        }
      });
    } catch (error) {
      // Dos aceptaciones simultáneas del mismo usuario: la otra ya dejó la evidencia.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
    return this.status(actor);
  }

  private async actorRole(actor: AuthUser) {
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: actor.workspaceId, userId: actor.sub },
      select: { role: true },
    });
    return member?.role ?? null;
  }
}
