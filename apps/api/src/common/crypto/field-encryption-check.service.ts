import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { activeEncryptionKid, decryptFieldStrict, encryptField, encryptedValueKid } from './field-encryption';

/** Muestras: el valor cifrado más reciente de unas pocas columnas representativas. */
const SAMPLES: { model: string; field: string }[] = [
  { model: 'clinicalHistory', field: 'currentProblem' },
  { model: 'session', field: 'notes' },
  { model: 'clinicalProcess', field: 'internalNotes' },
  { model: 'patient', field: 'consultationReason' },
  { model: 'message', field: 'body' },
];

/**
 * Autocomprobación al arrancar (nunca registra valores, solo modelo/campo/kid):
 *  1. Ida y vuelta con la clave activa: si la configuración de claves es inválida, la API no
 *     arranca (mejor que servir marcadores de "no se pudo descifrar").
 *  2. Intenta descifrar el valor cifrado más reciente de varias columnas. Si NINGUNO se puede
 *     descifrar, la clave configurada no es la de los datos: en producción la API no arranca.
 *     Si fallan solo algunos, se registra un error (puede ser un kid retirado o un dato dañado).
 */
@Injectable()
export class FieldEncryptionCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger('FieldEncryption');

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    const probe = 'asepsico-field-encryption-self-check';
    if (decryptFieldStrict(encryptField(probe)!) !== probe) throw new Error('Autocomprobación de cifrado fallida: ida y vuelta incorrecta');

    let checked = 0;
    const failed: string[] = [];
    for (const { model, field } of SAMPLES) {
      let row: Record<string, string> | null = null;
      try {
        row = await (this.prisma as any)[model].findFirst({ where: { [field]: { startsWith: 'enc:' } }, orderBy: { createdAt: 'desc' }, select: { [field]: true } });
      } catch {
        this.logger.warn(`No se pudo leer una muestra de ${model}.${field} para la autocomprobación`);
        continue;
      }
      if (!row?.[field]) continue;
      checked++;
      try {
        decryptFieldStrict(row[field]);
      } catch {
        failed.push(`${model}.${field} (kid ${encryptedValueKid(row[field]) ?? '?'})`);
      }
    }

    if (checked > 0 && failed.length === checked) {
      const message = `Ninguna muestra cifrada se puede descifrar con las claves configuradas (clave activa: ${activeEncryptionKid()}): ${failed.join(', ')}`;
      if (process.env.NODE_ENV === 'production') throw new Error(message);
      this.logger.error(message);
    } else if (failed.length) {
      this.logger.error(`Muestras cifradas ilegibles con las claves configuradas: ${failed.join(', ')}`);
    } else {
      this.logger.log(`Autocomprobación de cifrado OK (clave activa: ${activeEncryptionKid()}, muestras: ${checked})`);
    }
  }
}
