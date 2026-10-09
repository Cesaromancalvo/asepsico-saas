import { BadRequestException, HttpException, HttpStatus, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { STAFF_ROLES } from '../common/auth/assert-staff-role';
import type { LegalDocumentType, Prisma, PrismaClient } from '@prisma/client';
import { getCurrentLegalDocuments, LegalDocument } from './legal-documents';

/** Código de la respuesta 428 cuando un profesional tiene condiciones nuevas sin aceptar. */
export const TERMS_ACCEPTANCE_REQUIRED = 'TERMS_ACCEPTANCE_REQUIRED';
/** Código del 400 cuando el registro o la aceptación no cubre las versiones vigentes. */
export const TERMS_NOT_ACCEPTED = 'TERMS_NOT_ACCEPTED';

/** Código del 503 cuando en producción alguna condición vigente sigue siendo un borrador. */
export const LEGAL_TERMS_DRAFT = 'LEGAL_TERMS_DRAFT';

/**
 * En producción no se puede aceptar un borrador: registro, alta de miembro y aceptación responden
 * 503 LEGAL_TERMS_DRAFT mientras algún documento vigente conserve un marcador sin rellenar
 * ([PENDIENTE DEL DESPACHO], [NIF], [DOMICILIO]...). Sin válvula de escape: la antigua
 * LEGAL_ALLOW_DRAFT ya no existe y se ignora si alguien la define.
 */
export function assertLegalDocumentsPublishable(docs = getCurrentLegalDocuments(), env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const drafts = docs.filter((d) => d.draft);
  if (drafts.length > 0) {
    throw new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: LEGAL_TERMS_DRAFT,
      message: 'Las condiciones del servicio aún no están disponibles. Inténtalo más adelante.',
      drafts: drafts.map((d) => d.type),
    });
  }
}

export type AcceptedTermInput = { documentType: LegalDocumentType; version: string; textHash: string };
type Db = Pick<PrismaClient, 'termsAcceptance'> | Prisma.TransactionClient;

/** Referencia pública a un documento (sin el texto). */
export function legalDocumentRef(doc: LegalDocument) {
  return { documentType: doc.type, version: doc.version, title: doc.title, textHash: doc.textHash, draft: doc.draft };
}

/**
 * Exige que `accepted` incluya TODOS los documentos vigentes con su versión y hash exactos: el
 * cliente prueba así qué texto mostró. Lo que no coincida (versión antigua, texto cambiado) → 400.
 */
export function assertAcceptsCurrentTerms(accepted: AcceptedTermInput[] | undefined, docs = getCurrentLegalDocuments()) {
  const list = Array.isArray(accepted) ? accepted : [];
  const missing = docs.filter((d) => !list.some((a) => a.documentType === d.type && a.version === d.version && a.textHash === d.textHash));
  if (missing.length > 0) {
    throw new BadRequestException({
      statusCode: 400,
      code: TERMS_NOT_ACCEPTED,
      message: 'Para continuar debes aceptar las versiones vigentes de las condiciones',
      pending: missing.map(legalDocumentRef),
    });
  }
}

/**
 * Documentos vigentes que ESTE profesional aún no ha aceptado en ESTE workspace (en esa versión y
 * con ese texto). La aceptación es personal: la de otro miembro o de otro workspace no cuenta.
 */
export async function pendingLegalDocuments(db: Db, workspaceId: string, userId: string, docs = getCurrentLegalDocuments()): Promise<LegalDocument[]> {
  if (docs.length === 0) return [];
  const rows = await db.termsAcceptance.findMany({
    where: { workspaceId, userId, OR: docs.map((d) => ({ documentType: d.type, version: d.version, textHash: d.textHash })) },
    select: { documentType: true, version: true, textHash: true },
  });
  return docs.filter((d) => !rows.some((r) => r.documentType === d.type && r.version === d.version && r.textHash === d.textHash));
}

/**
 * Registra la aceptación de `docs` y su auditoría. Debe llamarse DENTRO de una $transaction:
 * evidencia y auditoría se escriben juntas o no se escribe ninguna.
 */
export async function recordTermsAcceptances(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; userId: string; docs: readonly LegalDocument[]; meta: { ip?: string; userAgent?: string } },
) {
  for (const doc of input.docs) {
    const row = await tx.termsAcceptance.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        documentType: doc.type,
        version: doc.version,
        textHash: doc.textHash,
        ipAddress: input.meta.ip,
        userAgent: input.meta.userAgent,
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'TERMS_ACCEPTED',
        entityType: 'TermsAcceptance',
        entityId: row.id,
        metadata: { documentType: doc.type, version: doc.version, textHash: doc.textHash },
        ipAddress: input.meta.ip,
        userAgent: input.meta.userAgent,
      },
    });
  }
}

/** Prefijo global de la API (main.ts: app.setGlobalPrefix('api/v1')). */
export const API_PREFIX = '/api/v1';

// Rutas que se pueden usar con condiciones pendientes: leerlas, aceptarlas, cerrar sesión y
// configurar el MFA (que JwtAuthGuard exige antes que nada). Comparación EXACTA con la ruta
// completa: una ruta que solo termine igual (p. ej. /api/v1/patients/legal/terms) no queda exenta.
const TERMS_PENDING_ALLOWED_PATHS: ReadonlySet<string> = new Set(
  ['/legal/terms', '/legal/terms/status', '/legal/terms/accept', '/auth/logout', '/auth/mfa/setup', '/auth/mfa/confirm'].map((p) => `${API_PREFIX}${p}`),
);

/**
 * Ruta normalizada para decidir las excepciones: sin query ni fragmento, sin barras finales y en
 * minúsculas (Express enruta sin distinguir mayúsculas ni la barra final, así que la excepción
 * cubre exactamente las mismas rutas que enruta, ni una más).
 */
export function normalizeRequestPath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0];
  const trimmed = withoutQuery.replace(/\/+$/, '');
  return (trimmed || '/').toLowerCase();
}

export function isTermsPendingAllowedPath(path: string): boolean {
  return TERMS_PENDING_ALLOWED_PATHS.has(normalizeRequestPath(path));
}

/**
 * Bloqueo por condiciones nuevas: afecta a TODO el personal del workspace (titular y miembros
 * invitados), porque cada uno acepta las condiciones por sí mismo. 428 con un código estable para
 * que la web muestre la pantalla de "nuevas condiciones". Los tokens sin rol de personal (portal
 * del paciente) no pasan por aquí: usan PortalGuard.
 */
export async function assertTermsAccepted(
  db: Db,
  user: { sub?: string; role?: string; workspaceId?: string } | undefined,
  path: string,
  docs = getCurrentLegalDocuments(),
) {
  if (!user || !(STAFF_ROLES as readonly string[]).includes(user.role ?? '')) return;
  // Falla cerrado: un token de personal sin usuario o workspace no es válido.
  if (typeof user.workspaceId !== 'string' || typeof user.sub !== 'string') throw new UnauthorizedException();
  if (isTermsPendingAllowedPath(path)) return;
  const pending = await pendingLegalDocuments(db, user.workspaceId, user.sub, docs);
  if (pending.length > 0) {
    throw new HttpException(
      {
        statusCode: HttpStatus.PRECONDITION_REQUIRED,
        code: TERMS_ACCEPTANCE_REQUIRED,
        message: 'Hay condiciones nuevas que debes aceptar antes de continuar',
        pending: pending.map(legalDocumentRef),
      },
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
}
