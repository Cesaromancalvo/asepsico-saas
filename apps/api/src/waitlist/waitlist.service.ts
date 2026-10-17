import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { encryptModelData } from '../common/crypto/clinical-crypto';
import { PrismaService } from '../database/prisma.service';
import { CreateWaitlistEntryDto } from './dto/create-waitlist-entry.dto';
import { checkFormToken, hashWaitlistEmail, issueFormToken } from './waitlist-crypto';
import { WAITLIST_FORM_MIN_SECONDS, WAITLIST_POLICY_VERSIONS_WITHOUT_COMMERCIAL } from './waitlist.config';

/** Respuesta única para alta nueva, alta repetida y honeypot: no revela si el email ya estaba. */
export const WAITLIST_ACCEPTED = { status: 'accepted' } as const;

/**
 * Lista de espera pública. Fuera de cualquier workspace (no hay workspaceId: es anterior a tener
 * cuenta). Reglas:
 *  - name, email y tools se guardan cifrados (registro waitlistEntry en clinical-crypto.ts).
 *  - Deduplicación por emailHash (HMAC); una segunda alta no toca la fila y no lo revela.
 *  - Los logs no llevan nunca nombre, email, herramientas, hash ni IP: solo el tipo de evento.
 *  - No se guarda IP ni user-agent: el rate limit por IP vive solo en la memoria del throttler.
 */
@Injectable()
export class WaitlistService {
  private readonly logger = new Logger('Waitlist');

  constructor(private readonly prisma: PrismaService) {}

  formToken() {
    return { formToken: issueFormToken(), minSeconds: WAITLIST_FORM_MIN_SECONDS };
  }

  async submit(dto: CreateWaitlistEntryDto): Promise<typeof WAITLIST_ACCEPTED> {
    if (dto.website && dto.website.trim() !== '') {
      this.logger.warn('Alta descartada: honeypot relleno');
      return WAITLIST_ACCEPTED;
    }

    // La política v3 ya no ofrece comunicaciones comerciales: no se registra una solicitud que no recoge.
    if (dto.commercialConsentRequested === true && WAITLIST_POLICY_VERSIONS_WITHOUT_COMMERCIAL.includes(dto.privacyPolicyVersion)) {
      this.logger.warn('Alta rechazada: casilla comercial con una versión de la política que no la ofrece');
      throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_COMMERCIAL_NOT_OFFERED', message: 'Esta versión de la política no incluye comunicaciones comerciales.' });
    }

    const token = checkFormToken(dto.formToken);
    if (token === 'too-fast') {
      this.logger.warn('Alta rechazada: formulario enviado demasiado rápido');
      throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_FORM_TOO_FAST', message: 'Espera unos segundos y vuelve a enviar el formulario.' });
    }
    if (token !== 'ok') {
      this.logger.warn('Alta rechazada: token de formulario inválido o caducado');
      throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_FORM_TOKEN_INVALID', message: 'El formulario ha caducado. Vuelve a enviarlo.' });
    }

    const now = new Date();
    const commercialConsentRequested = dto.commercialConsentRequested === true;
    const data = encryptModelData('waitlistEntry', {
      name: dto.name,
      email: dto.email.trim(),
      situation: dto.situation,
      tools: dto.tools ? dto.tools : null,
      professionalsCount: dto.professionalsCount ?? null,
      source: dto.source ?? null,
      privacyPolicyVersion: dto.privacyPolicyVersion,
      privacyAcceptedAt: now,
      // Solo la SOLICITUD (casilla marcada). El consentimiento válido (commercialConsent/At) lo
      // fija únicamente waitlist:confirm-commercial tras el doble opt-in por email.
      commercialConsentRequested,
      commercialConsentRequestedAt: commercialConsentRequested ? now : null,
    });

    // Solo CREATE (nunca upsert): una segunda alta con el mismo email no cambia nada de la fila
    // existente (ni nombre, ni herramientas, ni situación, ni consentimientos) y recibe el mismo
    // 202. El índice único de emailHash lo garantiza también con altas simultáneas (P2002).
    // Una fila suprimida tiene emailHash null, así que volver a apuntarse crea un alta nueva.
    try {
      await this.prisma.waitlistEntry.create({ data: { ...data, emailHash: hashWaitlistEmail(dto.email) } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.log('Alta repetida: sin cambios');
        return WAITLIST_ACCEPTED;
      }
      // Nunca se registra el error de Prisma tal cual: podría incluir valores de la consulta.
      this.logger.error(`Alta no guardada: error de base de datos (${(error as { code?: string })?.code ?? 'desconocido'})`);
      throw new InternalServerErrorException();
    }

    this.logger.log('Alta en la lista de espera registrada');
    return WAITLIST_ACCEPTED;
  }
}
