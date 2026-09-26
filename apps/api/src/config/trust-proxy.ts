import { isIP } from 'node:net';

/**
 * Configuración de `trust proxy` de Express a partir de la variable de entorno TRUST_PROXY.
 *
 * Por qué importa: el ThrottlerGuard usa `req.ip` como clave. Express calcula `req.ip` recorriendo
 * X-Forwarded-For de DERECHA a IZQUIERDA y se detiene en el primer salto que no es de confianza.
 * - Si confiamos de más (p. ej. `true`), `req.ip` pasa a ser la entrada más a la IZQUIERDA, que
 *   escribe el cliente: cualquiera se inventa una IP por petición y se salta el @Throttle.
 * - Si confiamos de menos cuando hay proxy, `req.ip` es la IP del proxy y todos los usuarios
 *   comparten el mismo contador (5 intentos/min bloquean el login de todos).
 *
 * Valores admitidos:
 * - (sin definir / vacío): `1` si NODE_ENV=production (comportamiento previo, un salto: el
 *   balanceador de Render); `false` en cualquier otro entorno (local/test/CI: sin proxy).
 * - `false` o `0`: no confiar en ningún proxy (se ignora X-Forwarded-For).
 * - Entero 1..5: número de saltos de proxy de confianza delante de la API.
 * - Lista separada por comas de IPs, subredes CIDR o los alias de Express
 *   `loopback`, `linklocal`, `uniquelocal`.
 * `true` se rechaza a propósito: confía en cualquier X-Forwarded-For del cliente.
 */
export type TrustProxySetting = false | number | string[];

const MAX_HOPS = 5;
const ALIASES = new Set(['loopback', 'linklocal', 'uniquelocal']);

export class InvalidTrustProxyError extends Error {
  constructor(raw: string, reason: string) {
    super(`TRUST_PROXY inválido (${JSON.stringify(raw)}): ${reason}`);
    this.name = 'InvalidTrustProxyError';
  }
}

function isValidAddressOrSubnet(entry: string): boolean {
  if (ALIASES.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return family === 4 ? bits <= 32 : bits <= 128;
}

export function parseTrustProxy(raw: string | undefined, nodeEnv: string | undefined): TrustProxySetting {
  const value = (raw ?? '').trim();
  if (value === '') {
    return nodeEnv === 'production' ? 1 : false;
  }

  const lower = value.toLowerCase();
  if (lower === 'false' || lower === '0') return false;
  if (lower === 'true') {
    throw new InvalidTrustProxyError(
      value,
      '"true" confía en cualquier X-Forwarded-For enviado por el cliente y permite saltarse el rate limit por IP. ' +
        'Usa un número de saltos (p. ej. 1) o una lista de IPs/subredes del proxy.',
    );
  }

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > MAX_HOPS) {
      throw new InvalidTrustProxyError(value, `el número de saltos debe estar entre 1 y ${MAX_HOPS}`);
    }
    return hops;
  }

  // Las entradas vacías ("10.0.0.1,,loopback", "a,", ",") se rechazan en lugar de ignorarse:
  // suelen delatar una variable mal copiada, y mejor fallar al arrancar que confiar en otra cosa.
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry === '')) {
    throw new InvalidTrustProxyError(value, 'la lista contiene entradas vacías (comas sobrantes)');
  }
  const invalid = entries.filter((entry) => !isValidAddressOrSubnet(entry));
  if (invalid.length > 0) {
    throw new InvalidTrustProxyError(
      value,
      `entradas no válidas: ${invalid.join(', ')}. ` +
        'Se espera un entero 1..5, "false", o una lista de IPs, subredes CIDR, loopback, linklocal o uniquelocal.',
    );
  }
  return entries;
}

/** Aplica la configuración a una instancia de Express (la de `app.getHttpAdapter().getInstance()`). */
export function applyTrustProxy(
  expressApp: { set(setting: string, value: unknown): unknown },
  env: NodeJS.ProcessEnv = process.env,
): TrustProxySetting {
  const setting = parseTrustProxy(env.TRUST_PROXY, env.NODE_ENV);
  expressApp.set('trust proxy', setting);
  return setting;
}

export function describeTrustProxy(setting: TrustProxySetting): string {
  if (setting === false) return 'desactivado (se ignora X-Forwarded-For)';
  if (typeof setting === 'number') return `${setting} salto(s) de proxy de confianza`;
  return `proxies de confianza: ${setting.join(', ')}`;
}
