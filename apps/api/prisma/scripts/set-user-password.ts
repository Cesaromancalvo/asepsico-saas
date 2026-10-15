/**
 * Cambia la contraseña de un PROFESIONAL (tabla User) desde la terminal del operador. La app aún
 * no permite que un profesional cambie la suya (solo existe el cambio del portal del paciente).
 *
 *   DATABASE_URL="$DB_URL" npm run users:set-password -- --email persona@example.com
 *
 * - La contraseña nueva se pide por stdin DOS veces y no se muestra (ni se pasa por argumentos,
 *   que quedarían en el historial y en `ps`). Mínimo 14 caracteres, máximo 72 bytes (bcrypt).
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
import { isValidEmailArg, PASSWORD_RESET_CLI_ACTION, SetPasswordError, setUserPassword, validateNewPassword } from './set-password/set-password-core';

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

/** Sin TTY (p. ej. `printf … | npm run …`): dos líneas de stdin. Tampoco se muestran. */
async function readTwoLinesFromPipe(): Promise<[string, string]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return [lines[0] ?? '', lines[1] ?? ''];
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

  let first: string;
  let second: string;
  if (process.stdin.isTTY) {
    first = await readHiddenFromTty('Contraseña nueva (no se muestra): ');
    second = await readHiddenFromTty('Repítela: ');
  } else {
    [first, second] = await readTwoLinesFromPipe();
  }
  const problem = validateNewPassword(first, second);
  if (problem) {
    console.error(`${problem} No se ha cambiado nada.`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const result = await setUserPassword(prisma, { email, password: first });
    console.log('Contraseña cambiada.');
    console.log(`Sesiones revocadas: ${result.revokedSessions}. Registros de auditoría (${PASSWORD_RESET_CLI_ACTION}): ${result.auditedWorkspaces}.`);
    console.log('Los navegadores con sesión abierta la pierden en 15 minutos como máximo.');
  } finally {
    first = '';
    second = '';
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof SetPasswordError) console.error(error.message);
  else console.error(`users:set-password falló: ${describeScriptError(error)}. No se ha cambiado nada.`);
  process.exit(1);
});
