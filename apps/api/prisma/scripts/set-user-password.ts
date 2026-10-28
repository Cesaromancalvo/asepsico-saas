/**
 * Cambia la contraseña de un PROFESIONAL (tabla User) desde la terminal del operador, auditado.
 *
 *   # Cuentas demo (por defecto solo acepta User.isDemo = true):
 *   DATABASE_URL="$DB_URL" npm run users:set-password -- --email recepcion.demo.xxxx@example.test
 *   DATABASE_URL="$DB_URL" npm run users:set-password -- --email terapeuta.demo.xxxx@example.test --reset-mfa
 *
 *   # Profesional real del piloto (manual de onboarding §3.7): el correo se pide al ejecutar.
 *   DATABASE_URL="$DB_URL" npm run users:set-password -- --allow-non-demo [--reset-mfa]
 *
 * - Muestra si la cuenta es demo y el espacio y el rol de cada membresía ACTIVE, y pide volver a
 *   escribir el correo; si no coincide, aborta (condición de Argos). Con una cuenta real pide además
 *   confirmar la verificación de identidad por videollamada.
 * - Exige una terminal (TTY): la contraseña nueva se pide DOS veces sin eco. Nunca por argumentos ni
 *   por tubería. Mínimo 14 caracteres, máximo 72 bytes. Opciones desconocidas (p. ej.
 *   `--allow-dev-secret` o `--password`) abortan antes de conectar.
 * - En una transacción: hash bcrypt coste 12, sube tokenVersion (los access tokens vivos dejan de
 *   valer al momento), passwordChangedAt, desbloquea el MFA, con --reset-mfa borra el TOTP y los
 *   códigos de recuperación, revoca todos los RefreshToken y audita en cada espacio activo.
 * - No imprime el correo, la contraseña ni el hash; los errores de Prisma salen sin argumentos.
 *
 * No necesita estar desplegado: se ejecuta desde un clon con `npm ci` y `npm run db:generate`.
 * Entorno: solo DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client';
import { describeScriptError } from './waitlist-script-utils';
import { createInterface } from 'node:readline/promises';
import { MFA_RESET_CLI_ACTION, parseCliArgs, PASSWORD_RESET_CLI_ACTION, runSetPasswordFlow, SetPasswordError } from './set-password/set-password-core';

/** Lee una línea de un TTY sin eco (modo raw). Ctrl+C aborta sin cambiar nada. */
function readHiddenFromTty(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(new SetPasswordError('Cancelado. No se ha cambiado nada.'));
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** Línea visible (correo, confirmaciones). */
async function askVisible(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function main() {
  // Primero los argumentos: una opción desconocida aborta sin tocar la base de datos.
  const options = parseCliArgs(process.argv.slice(2), process.env.DATABASE_URL);
  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL (léela con: read -rs DB_URL y pásala como DATABASE_URL="$DB_URL").');
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error('Ejecútalo en una terminal interactiva: la contraseña no se acepta por tubería ni por argumentos. No se ha cambiado nada.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const result = await runSetPasswordFlow(prisma, options, {
      print: (line) => console.log(line),
      ask: askVisible,
      askHidden: readHiddenFromTty,
    });
    console.log('Contraseña cambiada. Accesos abiertos invalidados al momento.');
    console.log(`Sesiones revocadas: ${result.revokedSessions}. Espacios auditados (${PASSWORD_RESET_CLI_ACTION}): ${result.auditedWorkspaces}.`);
    if (result.mfaReset) console.log(`Verificación en dos pasos borrada (${MFA_RESET_CLI_ACTION}): la configurará en el siguiente acceso.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof SetPasswordError) console.error(error.message);
  else console.error(`users:set-password falló: ${describeScriptError(error)}. No se ha cambiado nada.`);
  process.exit(1);
});
