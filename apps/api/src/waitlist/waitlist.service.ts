import { BadRequestException, Injectable, InternalServerErrorException, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { encryptModelData } from '../common/crypto/clinical-crypto';
import { PrismaService } from '../database/prisma.service';
import { CreateWaitlistEntryDto } from './dto/create-waitlist-entry.dto';
import { WaitlistNotifier } from './waitlist-notifier';
import { checkFormToken, hashWaitlistEmail, issueFormToken } from './waitlist-crypto';
import { normalizeWaitlistPhone } from './waitlist-phone';
import { ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS, WAITLIST_FORM_MIN_SECONDS } from './waitlist.config';

/** Respuesta única para alta nueva, alta repetida y honeypot: no revela si el email ya estaba. */
export const WAITLIST_ACCEPTED = { status: 'accepted' } as const;

/**
 * Lista de espera pública. Fuera de cualquier workspace (no hay workspaceId: es anterior a tener
 * cuenta). Reglas:
 *  - name, email, tools y phone se guardan cifrados (registro waitlistEntry en clinical-crypto.ts).
 *  - Solo se acepta la política vigente (v5); las retiradas (v1–v4) → 400 WAITLIST_POLICY_VERSION_RETIRED.
 *  - phone: obligatorio (phoneFor). Se guarda en E.164.
 *  - Deduplicación por emailHash (HMAC); una segunda alta no toca la fila y no lo revela.
 *  - Los logs no llevan nunca nombre, email, teléfono, herramientas, hash ni IP: solo el tipo de evento.
 *  - No se guarda IP ni user-agent: el rate limit por IP vive solo en la memoria del throttler.
 */
@Injectable()
export class WaitlistService {
  private readonly logger = new Logger('Waitlist');

  constructor(private readonly prisma: PrismaService, @Optional() private readonly notifier?: WaitlistNotifier) {}

  formToken() {
    return { formToken: issueFormToken(), minSeconds: WAITLIST_FORM_MIN_SECONDS };
  }

  async submit(dto: CreateWaitlistEntryDto): Promise<typeof WAITLIST_ACCEPTED> {
    if (dto.website && dto.website.trim() !== '') {
      this.logger.warn('Alta descartada: honeypot relleno');
      return WAITLIST_ACCEPTED;
    }

    // Solo la política vigente. El DTO deja pasar las retiradas (v1–v4) para darles este code propio;
    // se comprueba aquí también por defensa en profundidad (el servicio no depende del ValidationPipe).
    if (!(ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS as readonly string[]).includes(dto.privacyPolicyVersion)) {
      this.logger.warn('Alta rechazada: versión de la política retirada o no vigente');
      throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_POLICY_VERSION_RETIRED', message: 'Esta versión de la política ya no está vigente. Recarga la página y vuelve a enviar el formulario.' });
    }

    // Ninguna política vigente ofrece comunicaciones comerciales: no se registra una solicitud que no recoge.
    if (dto.commercialConsentRequested === true) {
      this.logger.warn('Alta rechazada: casilla comercial con una versión de la política que no la ofrece');
      throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_COMMERCIAL_NOT_OFFERED', message: 'Esta versión de la política no incluye comunicaciones comerciales.' });
    }

    const phone = this.phoneFor(dto);

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
    const data = encryptModelData('waitlistEntry', {
      name: dto.name,
      email: dto.email.trim(),
      situation: dto.situation,
      tools: dto.tools ? dto.tools : null,
      phone,
      professionalsCount: dto.professionalsCount ?? null,
      source: dto.source ?? null,
      privacyPolicyVersion: dto.privacyPolicyVersion,
      privacyAcceptedAt: now,
      // La política vigente no ofrece comunicaciones comerciales (true ya se ha rechazado arriba). Las
      // columnas siguen por las altas v2 y el consentimiento válido solo lo fija waitlist:confirm-commercial.
      commercialConsentRequested: false,
      commercialConsentRequestedAt: null,
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
    // Aviso interno al Jefe (sin datos del apuntado), ya guardada el alta. Solo programa el envío:
    // nunca bloquea ni hace fallar la respuesta pública. Las altas repetidas no avisan.
    try {
      this.notifier?.notifyNewEntry();
    } catch {
      this.logger.warn('Aviso de lista de espera no programado');
    }
    return WAITLIST_ACCEPTED;
  }

  /**
   * Teléfono obligatorio (política v5). Devuelve el teléfono en E.164. Una cadena vacía cuenta como
   * «no enviado». Los errores y los logs nombran el campo, nunca el valor.
   */
  private phoneFor(dto: CreateWaitlistEntryDto): string {
    const sent = typeof dto.phone === 'string' && dto.phone !== '';
    if (!sent) {
      this.logger.warn('Alta rechazada: falta el teléfono');
      throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_PHONE_REQUIRED', message: 'El teléfono es obligatorio.' });
    }
    const phone = normalizeWaitlistPhone(dto.phone);
    if (!phone) {
      this.logger.warn('Alta rechazada: teléfono con formato no válido');
      throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_PHONE_INVALID', message: 'El teléfono no tiene un formato válido.' });
    }
    return phone;
  }
}
