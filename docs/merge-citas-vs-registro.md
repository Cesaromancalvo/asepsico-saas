# Conflicto esperado: `feat/citas-entre-profesionales` ↔ `feat/registro-por-invitacion`

Comprobado con un merge de prueba (descartado) de `feat/registro-por-invitacion` (e101e7c) sobre
`feat/citas-entre-profesionales` ya actualizada con `origin/main` (9461737). Las dos ramas parten
de `462055d` (feat/e1-web). Hay **tres** archivos en conflicto; los tres son aditivos (ninguna rama
borra lo de la otra), así que la resolución es **quedarse con ambos lados**. El resto (ci.yml,
package.json, SECURITY_BASELINE.md) se fusiona solo.

Quien fusione en segundo lugar en `main` resuelve así:

## 1. `apps/web/lib/api.ts` (el que avisó Dora)

- **Citas** añade `ApiError.body` (cuerpo JSON del error) para leer `code` y `sessions` del 409
  `PROCESS_HAS_FUTURE_SESSIONS` al cerrar un proceso.
- **Registro** añade `ApiError.code` (tercer parámetro del constructor), `readError()` y
  `redirectToTermsIfRequired()` (428 `TERMS_ACCEPTANCE_REQUIRED`).

Resolución (las dos cosas; `readError` consume el cuerpo, así que se lee `body` de un `clone()` antes):

```ts
export class ApiError extends Error {
  /** Cuerpo JSON de la respuesta de error (p. ej. `code` y `sessions` del 409 al cerrar un proceso). */
  body: Record<string, unknown> = {};

  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// en api(), rama !response.ok:
const body = (await response.clone().json().catch(() => ({}))) as Record<string, unknown>;
const { message: apiMessage, code } = await readError(response);
let message = apiMessage ?? 'Error de conexión';
// ...429 Throttler igual que ahora...
redirectToTermsIfRequired(response.status, code);
const error = new ApiError(message, response.status, code);
error.body = body && typeof body === 'object' ? body : {};
throw error;
```

## 2. `packages/contracts/src/index.ts`

Bloques independientes añadidos en el mismo punto (tras `PatientContract`). Conservar los dos:
primero el de agenda/citas (`BusySessionContract`, `PatientAgendaResponse`,
`PROCESS_HAS_FUTURE_SESSIONS`, `ConversationListItemContract`…) y después el de registro
(`LegalDocumentContract`, `RegisterRequestContract`, `MemberInviteContract`…). No hay nombres repetidos.

## 3. `scripts/verify-ci-postgres.mjs`

Cada rama añade una comprobación tras la de `verify-mfa-concurrency`. Conservar las dos, cada una
con su `if (...) { throw ... }` cerrado: la de `session-close-race` (job `postgres-integration`,
después de `db:migrate:ci`, y guarda `RACE_DATABASE_REQUIRED`) y la de
`verify-registration-invite-live.mjs` (después del smoke). Ojo al cerrar llaves: en el conflicto
la `}` final es compartida.

## Verificación tras resolver

`npm run test:ci-config` · `npm run typecheck` · `npm --workspace @asepsico/api run test:security`
· `npm run build` · smoke real y `session-close-race` con `RACE_DATABASE_URL` + `RACE_DATABASE_REQUIRED=1`.
