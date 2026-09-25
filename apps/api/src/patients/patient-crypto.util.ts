import { decryptField } from '../common/crypto/field-encryption';

// consultationReason se cifra en reposo (ver common/crypto/field-encryption.ts). Centralizado
// aquí porque hay varios puntos de retorno distintos (PatientCoreService.get() y create(), pero
// también changeStatus(), restore() y block() en PatientLifecycleService devuelven el registro
// sin pasar por get()) y es fácil olvidar descifrar en alguno de ellos si no está en un único sitio.
export function decryptPatient<T extends { consultationReason?: string | null }>(patient: T): T {
  return { ...patient, consultationReason: decryptField(patient.consultationReason) ?? null };
}
