/**
 * Cambia la contraseña de un PROFESIONAL (tabla User) desde la terminal del operador. La app aún
 * no permite que un profesional cambie la suya (solo existe el cambio del portal del paciente).
 *
 *   DATABASE_URL="$DB_URL" npm run users:set-password -- --email persona@example.com
 *
 * - Antes de pedir la contraseña muestra el espacio y el rol de cada membresía de la cuenta y pide
 *   volver a escribir el correo; si no coincide, aborta (condición de Argos).
 * - Exige una terminal (TTY): la contraseña nueva se pide DOS veces sin eco. Ni por argumentos ni
 *   por tubería (`printf … |` la dejaría en el historial). Mínimo 14 caracteres, máximo 72 bytes.
 * - Mismo hash que el alta y el login (bcrypt, coste 12).
 * - Revoca TODOS los RefreshToken activos del usuario (cierra sus sesiones; el token de acceso
 *   que ya tenga un navegador caduca solo en ≤ 15 min).
 * - Deja un AuditLog `USER_PASSWORD_RESET_CLI` por espacio, sin datos personales.
 * - No imprime el correo, la contraseña ni el hash; los errores de Prisma salen sin argumentos.
 *
 * No necesita estar desplegado: se ejecuta desde un clon con `npm ci` y `npm run db:generate`,
 * como las migraciones. Entorno: solo DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client';
import { describeScriptError } from './waitlist-script-utils';
import { createInterface } from 'node:readline/promises';
import { isValidEmailArg, PASSWORD_RESET_CLI_ACTION, runSetPasswordFlow, SetPasswordError } from './set-password/set-password-core';

function arg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

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

/** Línea visible (confirmación del correo). */
async function askVisible(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function main() {
  const email = arg('email');
  if (!isValidEmailArg(email)) {
    console.error('Uso: DATABASE_URL=… npm run users:set-password -- --email persona@example.com');
    process.exit(1);
  }
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
    const result = await runSetPasswordFlow(prisma, email, {
      print: (line) => console.log(line),
      ask: askVisible,
      askHidden: readHiddenFromTty,
    });
    console.log('Contraseña cambiada.');
    console.log(`Sesiones revocadas: ${result.revokedSessions}. Registros de auditoría (${PASSWORD_RESET_CLI_ACTION}): ${result.auditedWorkspaces}.`);
    console.log('Los navegadores con sesión abierta la pierden en 15 minutos como máximo.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof SetPasswordError) console.error(error.message);
  else console.error(`users:set-password falló: ${describeScriptError(error)}. No se ha cambiado nada.`);
  process.exit(1);
});
