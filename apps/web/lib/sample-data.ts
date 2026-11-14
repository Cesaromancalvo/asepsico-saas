import type {
  ClearSampleDataRequestContract,
  ClearSampleDataResultContract,
  SampleDataErrorCode,
  SampleDataStatusContract,
  SamplePortalAccessContract,
  StaffRole,
} from '@asepsico/contracts';
import { api, ApiError, SESSION_EXPIRED } from './api';

/*
 * E1 · Espacio de prueba cargado (piloto demo).
 *
 * Todo lo de los datos de ejemplo es SOLO de la persona titular (OWNER): la API responde 403 al
 * resto. La web ni siquiera pregunta si el rol no es OWNER, para no insinuar nada a otros roles.
 *
 * La contraseña temporal del paciente de prueba (POST /sample-data/portal-access) se muestra una
 * sola vez: vive solo en el estado local de la pantalla de ajustes. Nunca se guarda en
 * localStorage, sessionStorage, la URL ni un estado global, y desaparece al salir de la pantalla.
 */

/** Dónde vive la sección «Datos de ejemplo» (ajustes, «Datos y piloto»). */
export const SAMPLE_DATA_SECTION_ID = 'datos-de-ejemplo';
export const SAMPLE_DATA_SETTINGS_HREF = `/settings/data#${SAMPLE_DATA_SECTION_ID}`;

/** Acceso al portal del paciente (la web usa `trailingSlash: true`). */
export const PORTAL_LOGIN_PATH = '/portal/login/';

export const SAMPLE_DATA_NOT_PURGEABLE: SampleDataErrorCode = 'SAMPLE_DATA_NOT_PURGEABLE';
export const SAMPLE_PORTAL_PATIENT_NOT_FOUND: SampleDataErrorCode = 'SAMPLE_PORTAL_PATIENT_NOT_FOUND';
/** 409: el modo de acceso al portal del paciente de prueba ya no admite su propia cuenta. */
export const SAMPLE_PORTAL_ACCESS_MODE_NOT_ALLOWED = 'SAMPLE_PORTAL_ACCESS_MODE_NOT_ALLOWED';

// [LEX/CLIO] texto pendiente de validar
export const SAMPLE_NOTICE_TITLE = 'Este es un espacio de prueba con pacientes inventados.';
// [LEX/CLIO] texto pendiente de validar
export const SAMPLE_NOTICE_NO_REAL_DATA = 'No introduzcas datos de pacientes reales.';
// [LEX/CLIO] texto pendiente de validar. Se usa en lugar de la frase anterior cuando ya se ve el
// aviso fijo «Entorno de prueba» (DemoBanner), que ya pide no introducir datos reales: así no se
// repite el mismo aviso dos veces en la misma pantalla.
export const SAMPLE_NOTICE_WITH_DEMO_BANNER =
  'Están ahí para que pruebes AsePsico sin preparar nada. Cuando quieras empezar de cero, bórralos desde Ajustes.';

// [LEX/CLIO] texto pendiente de validar. Al cargar los datos de ejemplo la API marca a la persona
// titular como «atiende pacientes» (auditado) para que pueda abrir las fichas de ejemplo: se explica.
export const SAMPLE_NOTICE_CLINICIAN = 'Te hemos marcado como profesional que atiende para que puedas ver las fichas de ejemplo.';

/** Solo la persona titular ve y gestiona los datos de ejemplo. */
export function canManageSampleData(role: StaffRole | null | undefined): boolean {
  return role === 'OWNER';
}

/** El aviso de espacio de prueba: solo OWNER, solo si se cargaron y no se han borrado. */
export function shouldShowSampleNotice(role: StaffRole | null | undefined, status: SampleDataStatusContract | null): boolean {
  return canManageSampleData(role) && !!status?.loaded && !status.clearedAt;
}

export function fetchSampleDataStatus(): Promise<SampleDataStatusContract> {
  return api<SampleDataStatusContract>('/sample-data');
}

/**
 * Estado de los datos de ejemplo para la UI. Sin llamar a la API si no es OWNER. Un 403 (el rol ha
 * cambiado) o un 404 (fuera del entorno del piloto demo las rutas no existen) se tratan igual que
 * «no hay nada que enseñar». Otros errores se lanzan.
 */
export async function loadSampleDataStatus(role: StaffRole | null | undefined): Promise<SampleDataStatusContract | null> {
  if (!canManageSampleData(role)) return null;
  try {
    return await fetchSampleDataStatus();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

/** Genera una contraseña temporal NUEVA (la anterior deja de valer) y la devuelve una sola vez. */
export function requestSamplePortalAccess(): Promise<SamplePortalAccessContract> {
  return api<SamplePortalAccessContract>('/sample-data/portal-access', { method: 'POST' });
}

export function clearSampleData(): Promise<ClearSampleDataResultContract> {
  const body: ClearSampleDataRequestContract = { confirm: true };
  return api<ClearSampleDataResultContract>('/sample-data/clear', { method: 'POST', body: JSON.stringify(body) });
}

function isSessionExpired(err: unknown): boolean {
  return err instanceof ApiError && err.code === SESSION_EXPIRED;
}

const FORBIDDEN_MESSAGE = 'Solo la persona titular del espacio puede gestionar los datos de ejemplo.';

/** Mensaje entendible si falla «Ver el portal como paciente». */
export function portalAccessErrorMessage(err: unknown): string {
  // La petición no llegó a hacerse con sesión: no se ha generado ninguna contraseña.
  if (isSessionExpired(err)) {
    return 'Tu sesión ha caducado y no se ha generado ninguna contraseña. Inicia sesión de nuevo y vuelve a pulsar «Ver el portal como paciente».';
  }
  if (err instanceof ApiError && err.code === SAMPLE_PORTAL_PATIENT_NOT_FOUND) {
    return 'El paciente de prueba con acceso al portal ya no existe (se borró con los datos de ejemplo).';
  }
  if (err instanceof ApiError && err.code === SAMPLE_PORTAL_ACCESS_MODE_NOT_ALLOWED) {
    return 'El paciente de prueba ya no tiene un acceso propio al portal (se cambió su modo de acceso en su ficha), así que no se puede generar su contraseña.';
  }
  if (err instanceof ApiError && err.status === 403) return FORBIDDEN_MESSAGE;
  if (err instanceof ApiError && err.status === 429) return 'Has pedido varias contraseñas seguidas. Espera un minuto y vuelve a intentarlo.';
  return 'No hemos podido generar el acceso al portal. Inténtalo de nuevo en unos segundos.';
}

/** Mensaje entendible si falla «Borrar los datos de ejemplo». */
export function clearErrorMessage(err: unknown): string {
  if (isSessionExpired(err)) {
    return 'Tu sesión ha caducado y no se ha borrado nada. Inicia sesión de nuevo y vuelve a intentarlo.';
  }
  if (err instanceof ApiError && (err.status === 409 || err.code === SAMPLE_DATA_NOT_PURGEABLE)) {
    return 'No se ha borrado nada: algún paciente de ejemplo tiene facturas emitidas y las facturas emitidas no se pueden eliminar. Tus datos siguen como estaban.';
  }
  if (err instanceof ApiError && err.status === 403) return FORBIDDEN_MESSAGE;
  if (err instanceof ApiError && err.status === 429) return 'Has hecho varios intentos seguidos. Espera un minuto y vuelve a intentarlo.';
  return 'No hemos podido borrar los datos de ejemplo. No se ha borrado nada; inténtalo de nuevo en unos segundos.';
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** «Se han borrado 4 pacientes, 12 citas y 3 procesos de ejemplo.» */
export function clearResultMessage(result: ClearSampleDataResultContract): string {
  const { patients, sessions, processes } = result.deleted;
  return `Listo. Se han borrado ${plural(patients, 'paciente', 'pacientes')}, ${plural(sessions, 'cita', 'citas')} y ${plural(processes, 'proceso', 'procesos')} de ejemplo. Los pacientes que hayas creado tú siguen igual.`;
}

export function formatSampleDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

/** «Hay 5 pacientes de ejemplo desde el 12 de noviembre de 2026.» */
export function sampleStatusSummary(status: SampleDataStatusContract): string {
  if (status.clearedAt) return `Borraste los datos de ejemplo el ${formatSampleDate(status.clearedAt)}.`;
  const since = formatSampleDate(status.loadedAt);
  const count = status.samplePatients === 1 ? 'Hay 1 paciente de ejemplo' : `Hay ${status.samplePatients} pacientes de ejemplo`;
  return since ? `${count} desde el ${since}.` : `${count}.`;
}

/*
 * El aviso de Mi jornada se puede cerrar. Solo se recuerda ESO (un "1" por espacio y navegador): ni
 * nombres, ni datos del espacio, ni nada de la contraseña. Si el almacenamiento no está disponible
 * (modo privado, bloqueado), el aviso simplemente vuelve a salir.
 */
const DISMISS_KEY = 'asepsico:aviso-espacio-prueba-cerrado';

function dismissKey(scope: string | null | undefined) {
  return scope ? `${DISMISS_KEY}:${scope}` : DISMISS_KEY;
}

export function isSampleNoticeDismissed(scope: string | null | undefined, storage: Pick<Storage, 'getItem'> | null = browserStorage()): boolean {
  try {
    return storage?.getItem(dismissKey(scope)) === '1';
  } catch {
    return false;
  }
}

export function setSampleNoticeDismissed(scope: string | null | undefined, dismissed: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = browserStorage()) {
  try {
    if (dismissed) storage?.setItem(dismissKey(scope), '1');
    else storage?.removeItem(dismissKey(scope));
  } catch {
    // Sin almacenamiento: el cierre dura lo que dure la pantalla.
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
