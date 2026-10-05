import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { encryptModelData } from '../common/crypto/clinical-crypto';
import { PrismaService } from '../database/prisma.service';
import { CreateWaitlistEntryDto } from './dto/create-waitlist-entry.dto';
import { checkFormToken, hashWaitlistEmail, issueFormToken } from './waitlist-crypto';
import { WAITLIST_FORM_MIN_SECONDS } from './waitlist.config';

/** Respuesta única para alta nueva, alta repetida y honeypot: no revela si el email ya estaba. */
export const WAITLIST_ACCEPTED = { status: 'accepted' } as const;

/**
 * Lista de espera pública. Fuera de cualquier workspace (no hay workspaceId: es anterior a tener
 * cuenta). Reglas:
 *  - name, email y tools se guardan cifrados (registro waitlistEntry en clinical-crypto.ts).
 *  - Deduplicación por emailHash (HMAC); una segunda alta actualiza la fila sin revelarlo.
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
    const commercialConsent = dto.commercialConsent === true;
    const data = encryptModelData('waitlistEntry', {
      name: dto.name,
      email: dto.email.trim(),
      situation: dto.situation,
      tools: dto.tools ? dto.tools : null,
      professionalsCount: dto.professionalsCount ?? null,
      source: dto.source,
      privacyPolicyVersion: dto.privacyPolicyVersion,
      privacyAcceptedAt: now,
      commercialConsent,
      deletedAt: null,
    });
    const emailHash = hashWaitlistEmail(dto.email);

    // Upsert atómico por el índice único de emailHash. La última alta manda (incluida la casilla
    // comercial: marcarla la concede con fecha; desmarcarla la retira). Si la fila estaba
    // suprimida, su emailHash ya es null, así que esto crea una alta nueva.
    try {
      await this.prisma.waitlistEntry.upsert({
        where: { emailHash },
        create: { ...data, emailHash, commercialConsentAt: commercialConsent ? now : null },
        update: { ...data, commercialConsentAt: commercialConsent ? now : null },
      });
    } catch (error) {
      // Nunca se registra el error de Prisma tal cual: podría incluir valores de la consulta.
      this.logger.error(`Alta no guardada: error de base de datos (${(error as { code?: string })?.code ?? 'desconocido'})`);
      throw new InternalServerErrorException();
    }

    this.logger.log('Alta en la lista de espera registrada');
    return WAITLIST_ACCEPTED;
  }
}
