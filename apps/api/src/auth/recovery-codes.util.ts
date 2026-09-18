import { randomInt } from 'crypto';
import { hash, compare } from 'bcryptjs';

const RECOVERY_CODE_COUNT = 10;

function generateOneCode(): string {
  const part = () => String(randomInt(0, 100000)).padStart(5, '0');
  return `${part()}-${part()}`;
}

/** Genera N códigos de recuperación en texto plano, para mostrar UNA sola vez al usuario. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, generateOneCode);
}

/** Hashea cada código (igual que una contraseña) para guardarlos en la base de datos. */
export async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => hash(code, 10)));
}

/**
 * Comprueba un código de recuperación contra la lista de hashes guardados.
 * Devuelve el índice del hash que coincidió (para poder eliminarlo, de un solo uso),
 * o -1 si no coincide con ninguno.
 */
export async function findMatchingRecoveryCodeIndex(candidate: string, hashedCodes: string[]): Promise<number> {
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await compare(candidate, hashedCodes[i])) return i;
  }
  return -1;
}
