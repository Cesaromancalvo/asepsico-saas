/**
 * Teléfono de una persona ya apuntada a la lista de espera, sin tocar la base de datos a mano
 * (un UPDATE con SQL guardaría el teléfono en claro y rompería el cifrado).
 *
 *  - Registrar o corregir (los apuntados v2–v4 que lo den respondiendo al correo, y SOLO después de
 *    publicar la política v5): valida y normaliza con la misma regla que la API y lo guarda cifrado.
 *  - --clear: borra SOLO el teléfono (la persona no quiere más llamadas); sigue en la lista.
 *
 * El email y el teléfono NUNCA van en la línea de la orden (quedarían en el historial de la shell y
 * en la lista de procesos): se leen por la entrada estándar. En una terminal, el CLI los pide sin
 * mostrarlos. Desde el clon de despliegue, con las claves leídas también con read -rs:
 *
 *   read -rs WL_EMAIL; read -rs WL_PHONE
 *   printf '%s\n%s\n' "$WL_EMAIL" "$WL_PHONE" | npm run waitlist:set-phone
 *   printf '%s\n' "$WL_EMAIL" | npm run waitlist:set-phone -- --clear
 *   unset WL_EMAIL WL_PHONE
 *
 * --allow-dev-secret (claves de desarrollo) solo con una DATABASE_URL local: con cualquier otra, el
 * CLI termina con error antes de conectar.
 *
 * Entorno: DATABASE_URL, WAITLIST_SECRET (el de la API, para encontrar el email) y la clave de
 * cifrado de campos de la API (para cifrar el teléfono). Cada cambio queda en PlatformAuditLog
 * (sin actor, source 'cli') sin el teléfono ni el email. Por pantalla solo sale el resultado.
 */
import { clearWaitlistPhoneByEmail, setWaitlistPhone } from '../../src/waitlist/waitlist-admin';
import { assertEmailLookupConfig, isLocalDatabaseUrl, runWaitlistCli } from './waitlist-script-utils';

const args = process.argv.slice(2);
const CLEAR = args.includes('--clear');
const KNOWN = new Set(['--clear', '--allow-dev-secret']);
const EMAIL_STDIN_HINT = 'Falta el email: se lee de la primera línea de la entrada estándar (printf … | npm run waitlist:set-phone) o, en una terminal, del aviso que no lo muestra. Nunca como argumento.';

/** Lee una línea de una terminal sin mostrarla (modo raw). Ctrl+C cancela sin escribir nada. */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolvePrompt, rejectPrompt) => {
    const stdin = process.stdin;
    process.stderr.write(label);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (error?: Error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      if (error) rejectPrompt(error);
      else resolvePrompt(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') return done(new Error('Cancelado: no se ha cambiado nada.'));
        if (char === '\r' || char === '\n') return done();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map((line) => line.trim());
}

async function readInputs(): Promise<{ email: string; phone: string }> {
  if (process.stdin.isTTY) {
    const email = (await promptHidden('Email de la persona (no se muestra): ')).trim();
    const phone = CLEAR ? '' : (await promptHidden('Teléfono (no se muestra): ')).trim();
    return { email, phone };
  }
  const [email = '', phone = ''] = await readStdinLines();
  return { email, phone };
}

const MESSAGES = {
  updated: 'Teléfono guardado (cifrado).',
  cleared: 'Teléfono borrado. La persona sigue en la lista de espera.',
  'no-phone': 'Esa alta no tenía teléfono: no se ha cambiado nada.',
  invalid: 'El teléfono no tiene un formato válido: no se ha guardado nada.',
  'not-found': 'No hay ninguna alta activa con ese email (revisa que WAITLIST_SECRET sea el de producción).',
} as const;

runWaitlistCli('waitlist:set-phone', async (prisma) => {
  const unknown = args.filter((arg) => !KNOWN.has(arg));
  if (unknown.length) {
    throw new Error('Argumentos no admitidos. El email y el teléfono se pasan por la entrada estándar, nunca en la orden (ver la cabecera del script).');
  }
  // Condición de Argos: las claves de desarrollo solo contra una base de datos de este equipo. Se
  // comprueba antes de leer nada y de conectar: con una BD remota, sale con error sin escribir.
  if (args.includes('--allow-dev-secret') && !isLocalDatabaseUrl(process.env.DATABASE_URL)) {
    throw new Error('--allow-dev-secret solo se admite con una DATABASE_URL local (localhost, 127.0.0.1, ::1 o *.localhost). Contra otra base de datos, usa WAITLIST_SECRET y la clave de cifrado de la API.');
  }
  const { email, phone } = await readInputs();
  assertEmailLookupConfig(args, email, EMAIL_STDIN_HINT);
  if (!CLEAR && !phone) throw new Error('Falta el teléfono (segunda línea de la entrada estándar). Para borrarlo, usa --clear.');
  // Sin la clave de la API se cifraría con la de desarrollo y el panel lo mostraría como «No legible».
  if (!CLEAR && !process.env.FIELD_ENCRYPTION_KEY && !process.env.FIELD_ENCRYPTION_KEYS && !args.includes('--allow-dev-secret')) {
    throw new Error('Falta FIELD_ENCRYPTION_KEY o FIELD_ENCRYPTION_KEYS (las de la API) para cifrar el teléfono. Solo en local: --allow-dev-secret.');
  }
  const result = CLEAR ? await clearWaitlistPhoneByEmail(prisma, email) : await setWaitlistPhone(prisma, email, phone);
  console.log(MESSAGES[result]);
  if (result !== 'updated' && result !== 'cleared') process.exitCode = 2;
});
