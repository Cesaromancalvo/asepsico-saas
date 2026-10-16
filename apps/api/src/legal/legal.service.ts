import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { getCurrentLegalDocuments } from './legal-documents';
import { AcceptTermsDto } from './dto/accept-terms.dto';
import { assertAcceptsCurrentTerms, assertLegalDocumentsPublishable, legalDocumentRef, pendingLegalDocuments, recordTermsAcceptances } from './terms-acceptance';

@Injectable()
export class LegalService {
  constructor(private readonly prisma: PrismaService) {}

  /** Textos vigentes (públicos: la pantalla de registro los enseña antes de iniciar sesión). */
  currentDocuments() {
    return getCurrentLegalDocuments().map((doc) => ({ ...legalDocumentRef(doc), text: doc.text }));
  }

  /**
   * Estado para la sesión actual. Cada profesional (titular o miembro) acepta por sí mismo.
   * `canAccept` se mantiene por compatibilidad del contrato: es true para cualquier miembro.
   */
  async status(actor: AuthUser) {
    assertStaffRole(actor);
    const [role, pending] = await Promise.all([
      this.actorRole(actor),
      pendingLegalDocuments(this.prisma, actor.workspaceId, actor.sub),
    ]);
    return {
      acceptanceRequired: pending.length > 0,
      canAccept: role !== null,
      pending: pending.map(legalDocumentRef),
    };
  }

  /**
   * El profesional acepta las versiones vigentes para sí mismo, si pertenece al workspace según la
   * BD (no basta el token). Evidencia y auditoría en la misma transacción.
   */
  async accept(actor: AuthUser, dto: AcceptTermsDto, meta: { ip?: string; userAgent?: string }) {
    assertStaffRole(actor);
    assertLegalDocumentsPublishable();
    if ((await this.actorRole(actor)) === null) {
      throw new ForbiddenException('No perteneces a esta consulta');
    }
    assertAcceptsCurrentTerms(dto.acceptedTerms);
    try {
      await this.prisma.$transaction(async (tx) => {
        const pending = await pendingLegalDocuments(tx, actor.workspaceId, actor.sub);
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
