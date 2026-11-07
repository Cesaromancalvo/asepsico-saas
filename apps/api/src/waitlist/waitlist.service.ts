import { BadRequestException, Injectable, InternalServerErrorException, Logger, Optional } from '@nestjs/common';
import { Prisma, WaitlistContactPreference } from '@prisma/client';
import { encryptModelData } from '../common/crypto/clinical-crypto';
import { PrismaService } from '../database/prisma.service';
import { CreateWaitlistEntryDto } from './dto/create-waitlist-entry.dto';
import { WaitlistNotifier } from './waitlist-notifier';
import { checkFormToken, hashWaitlistEmail, issueFormToken } from './waitlist-crypto';
import { normalizeWaitlistPhone } from './waitlist-phone';
import { CURRENT_WAITLIST_PRIVACY_POLICY_VERSION, WAITLIST_FORM_MIN_SECONDS, isWaitlistPolicyVersionAccepted } from './waitlist.config';

/** Respuesta única para alta nueva, alta repetida y honeypot: no revela si el email ya estaba. */
export const WAITLIST_ACCEPTED = { status: 'accepted' } as const;

/**
 * Lista de espera pública. Fuera de cualquier workspace (no hay workspaceId: es anterior a tener
 * cuenta). Reglas:
 *  - name, email, tools y phone se guardan cifrados (registro waitlistEntry en clinical-crypto.ts).
 *  - Se acepta la política vigente (v6) y la v5 solo durante su transición (waitlist.config.ts); las
 *    retiradas (v1–v4, y la v5 fuera de plazo) → 400 WAITLIST_POLICY_VERSION_RETIRED.
 *  - contactPreference y phone según la versión (contactFor): v6 con preferencia obligatoria y
 *    teléfono solo con PHONE_AND_EMAIL; v5 sin preferencia y con teléfono obligatorio. E.164.
 *  - La preferencia, como el resto de datos, no sale en logs ni en el aviso interno.
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

    // Solo la vigente (y la v5 en transición). El DTO deja pasar las retiradas para darles este code
    // propio; se comprueba aquí también por defensa en profundidad (no depende del ValidationPipe).
    if (!isWaitlistPolicyVersionAccepted(dto.privacyPolicyVersion)) {
      this.logger.warn('Alta rechazada: versión de la política retirada o no vigente');
      throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_POLICY_VERSION_RETIRED', message: 'Esta versión de la política ya no está vigente. Recarga la página y vuelve a enviar el formulario.' });
    }

    // Ninguna política vigente ofrece comunicaciones comerciales: no se registra una solicitud que no recoge.
    if (dto.commercialConsentRequested === true) {
      this.logger.warn('Alta rechazada: casilla comercial con una versión de la política que no la ofrece');
      throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_COMMERCIAL_NOT_OFFERED', message: 'Esta versión de la política no incluye comunicaciones comerciales.' });
    }

    const { contactPreference, phone } = this.contactFor(dto);

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
      contactPreference,
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
   * Preferencia de contacto y teléfono según la versión de la política (Lex Psi, revisión 03/11/2026
   * §1.1 y §1.4). Los errores y los logs nombran el campo, nunca el valor.
   *  - v6: preferencia obligatoria. PHONE_AND_EMAIL → teléfono obligatorio y válido. EMAIL_ONLY →
   *    el teléfono NO puede llegar (ni vacío ni null): 400 WAITLIST_PHONE_NOT_ALLOWED.
   *  - v5 (transición): sin campo de preferencia (si llega → 400) y teléfono obligatorio; se guarda
   *    PHONE_AND_EMAIL porque la casilla de la v5 consintió las llamadas.
   */
  private contactFor(dto: CreateWaitlistEntryDto): { contactPreference: WaitlistContactPreference; phone: string | null } {
    if (dto.privacyPolicyVersion === CURRENT_WAITLIST_PRIVACY_POLICY_VERSION) {
      if (dto.contactPreference === WaitlistContactPreference.EMAIL_ONLY) {
        if (dto.phone !== undefined) {
          this.logger.warn('Alta rechazada: teléfono enviado con la preferencia de contacto que no lo admite');
          throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_PHONE_NOT_ALLOWED', message: 'Si eliges que te contactemos solo por email, no envíes el teléfono.' });
        }
        return { contactPreference: WaitlistContactPreference.EMAIL_ONLY, phone: null };
      }
      if (dto.contactPreference === WaitlistContactPreference.PHONE_AND_EMAIL) {
        return { contactPreference: WaitlistContactPreference.PHONE_AND_EMAIL, phone: this.requiredPhone(dto) };
      }
      this.logger.warn('Alta rechazada: falta la preferencia de contacto');
      throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_CONTACT_PREFERENCE_REQUIRED', message: 'Elige cómo prefieres que te contactemos.' });
    }
    // Única otra versión que llega aquí: la v5 en transición (isWaitlistPolicyVersionAccepted).
    if (dto.contactPreference !== undefined) {
      this.logger.warn('Alta rechazada: preferencia de contacto con una versión de la política que no la ofrece');
      throw new BadRequestException({ statusCode: 400, code: 'WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED', message: 'Esta versión de la política no incluye la preferencia de contacto. Recarga la página y vuelve a enviar el formulario.' });
    }
    return { contactPreference: WaitlistContactPreference.PHONE_AND_EMAIL, phone: this.requiredPhone(dto) };
  }

  /** Teléfono obligatorio, en E.164. Una cadena vacía cuenta como «no enviado». */
  private requiredPhone(dto: CreateWaitlistEntryDto): string {
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
