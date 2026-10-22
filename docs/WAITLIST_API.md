# Lista de espera: contrato de la API para la landing

Implementación en `apps/api/src/waitlist/`; tipos en `packages/contracts/src/waitlist.ts`.
La landing (`apps/landing`, estática, sin cookies) llama a la API directamente desde el navegador.

## URL

```
API = https://asepsico-api.onrender.com/api/v1   ← HOST A CONFIRMAR POR DORA (no verificado)
```

- La landing debe leer la URL de **una constante configurable** (p. ej. `API_BASE_URL` en
  `apps/landing/public/js/config.js`), no escribirla en varios sitios: el host
  `asepsico-api.onrender.com` sale de los traspasos y **Dora debe confirmarlo** (o dar el
  dominio propio) antes de publicar. La misma URL va en la CSP.
- Llamar **directamente** al servicio de Render, no a través del dominio de la app en Vercel: si
  la petición pasara por el *rewrite* de Vercel, la API vería la IP de Vercel y el rate limit por
  IP sería compartido por todos los visitantes.
- Si Dora publica la API con dominio propio (p. ej. `https://api.asepsico.es`), cambiar la URL y la
  CSP, y revisar `TRUST_PROXY` (un proxy más delante cambia el número de saltos; ver
  `ops/PILOT_RUNBOOK.md`).

## CSP de la landing (Render → Settings → Headers)

Añadir el origen de la API a `connect-src` (y nada más):

```
connect-src 'self' https://asepsico-api.onrender.com
```

(El host, igual que arriba, a confirmar por Dora.)

`form-action 'none'` puede quedarse así si el envío se hace con `fetch` (recomendado). Si se quiere
un `<form action>` de respaldo sin JavaScript, habría que añadir la URL a `form-action`, pero la API
espera JSON: el respaldo sin JS no está soportado. También hay que añadir el host a
`ALLOWED_HOSTS` de `scripts/check-landing.mjs` si aparece en el HTML o en `js/config.js`.

## Flujo

Todas las peticiones con `fetch(..., { mode: 'cors', credentials: 'omit' })`. Sin cookies.

### 1. `GET {API}/public/waitlist/form-token`

La landing lo pide al cargar la portada (despierta la API del plan gratuito de Render, con un arranque
en frío de ~72 s) y otra vez al enfocar o enviar si ha fallado o caducado. Respuesta `200`:

```json
{ "formToken": "1759700000000.AbCd....firma", "minSeconds": 3 }
```

El token caduca a las 2 horas y no se puede usar hasta pasados `minSeconds` segundos.

### 2. `POST {API}/public/waitlist`

`Content-Type: application/json`. Cuerpo de **16 KB como máximo** (más → 413; un `Content-Type` distinto de JSON → 415). Cualquier campo no listado → 400:

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `name` | string | sí | 2–120 caracteres (se recortan espacios) |
| `email` | string | sí | email válido, máx. 254 |
| `situation` | enum | sí | `SELF_EMPLOYED` (autónomo/a) · `PRACTICE` (consulta/clínica) · `STUDENT` · `OTHER` |
| `tools` | string | no | máx. 500. Herramientas que usa hoy. La landing manda la opción elegida tal cual (`Doctoralia`, `Eholo`, `Excel / hojas de cálculo`, `Papel / agenda`, `Nada todavía`, `Otra`) o `Otra: <texto>` (texto de máx. 100). Sin caracteres de control (se admiten saltos de línea y tabulador) → si no, 400 |
| `professionalsCount` | entero | no | 1–500 |
| `source` | enum | no | `INSTAGRAM` · `COLLEAGUE` (un compañero) · `PROFESSIONAL_COLLEGE` (Colegio) · `SEARCH_ENGINE` (Google o Bing) · `OTHER` · `NOT_SAID` ("Prefiero no decirlo") |
| `privacyAccepted` | boolean | sí | debe ser `true` |
| `privacyPolicyVersion` | string | sí | la versión que muestra la página de privacidad: la landing envía `lista-espera-v4`. Durante la transición la API acepta `lista-espera-v2`, `lista-espera-v3` y `lista-espera-v4` (`ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS`); cualquier otra (incluida `lista-espera-v1`) → 400. Se guarda tal cual. Al cambiar de versión: **desplegar primero la API y después la landing**, y retirar la anterior cuando la landing ya no la sirva |
| `commercialConsentRequested` | boolean | no | **la landing ya no lo envía** (se quitó la casilla de novedades): sin el campo, la API guarda `false`. Se sigue aceptando por compatibilidad. Antes: casilla opcional, desmarcada por defecto (texto según la política `lista-espera-v2` de Lex Psi). Solo registra la **solicitud** con fecha; **no es un consentimiento válido** hasta el doble opt-in por email. Cualquier campo `commercialConsent*` distinto de este → 400 **Con `lista-espera-v3` o `lista-espera-v4`, `true` → 400 `WAITLIST_COMMERCIAL_NOT_OFFERED`** (esas políticas no ofrecen comunicaciones comerciales; `false` o sin el campo, se acepta) |
| `formToken` | string | sí | el del paso 1 |
| `website` | string | no | honeypot: input de texto oculto con CSS (clase, no `style=`), `tabindex="-1"`, `autocomplete="off"`, `aria-hidden="true"`; siempre vacío |

## Respuestas

| Estado | Cuerpo | Qué hacer en la landing |
|---|---|---|
| `202` | `{ "status": "accepted" }` | Mensaje de éxito genérico ("Si los datos son correctos, te escribiremos…"). Es la misma respuesta para alta nueva, email ya apuntado y honeypot: no decir "ya estabas apuntado/a". **Una segunda alta con el mismo email no cambia nada** (ni datos ni casilla comercial): si alguien quiere corregir datos o retirar el consentimiento, que escriba al email de contacto |
| `400` | `{ "statusCode": 400, "code": "WAITLIST_FORM_TOO_FAST", "message": "…" }` | Esperar `minSeconds` y reenviar automáticamente una vez |
| `400` | `{ "statusCode": 400, "code": "WAITLIST_FORM_TOKEN_INVALID", "message": "…" }` | Pedir otro token, esperar `minSeconds` y reenviar una vez |
| `400` | `{ "statusCode": 400, "message": ["email must be an email", …], "error": "Bad Request" }` | Error de validación (también si no se acepta la política). Validar antes en el navegador con las mismas reglas y mostrar un mensaje propio en español |
| `413` | `{ "statusCode": 413, "message": "Payload Too Large" }` | No debería ocurrir con los límites de los campos. Mensaje genérico |
| `415` | `{ "statusCode": 415, "message": "Unsupported Media Type" }` | Enviar siempre `Content-Type: application/json` |
| `403` | `{ "statusCode": 403, "message": "Origen no permitido" }` | Configuración (origen no permitido). Mensaje genérico de error |
| `429` | `{ "statusCode": 429, "message": "ThrottlerException: Too Many Requests" }` | "Has hecho demasiados intentos. Prueba de nuevo en unos minutos." |
| `5xx` / red | — | Mensaje genérico y el email de contacto como alternativa. Render puede tardar en despertar: timeout generoso (≈30 s) |

Límites por IP: 5 envíos y 80 tokens cada 10 minutos.

## Variables de entorno de la API (Dora)

| Variable | Producción |
|---|---|
| `WAITLIST_SECRET` | Obligatoria, `openssl rand -base64 32`. La API no arranca sin ella. **No se rota**: cambiarla rompe la deduplicación y `waitlist:delete` de todas las altas previas |
| `WAITLIST_ALLOWED_ORIGINS` | Vacía (= `https://asepsico.es,https://www.asepsico.es`) |

## Gestión (César, por CLI)

```bash
npm run waitlist:export -- --out ~/ruta/privada/lista-espera.csv   # fuera del repo; no sobrescribe
npm run waitlist:delete -- --email persona@example.com             # supresión
npm run waitlist:purge -- --dry-run                                # purga por plazo (12 meses)
npm run waitlist:confirm-commercial -- --email persona@example.com # tras su "Sí" por email
npm run waitlist:withdraw-commercial -- --email persona@example.com
```

- **Claves de producción solo en ejecuciones puntuales**: `DATABASE_URL`, `WAITLIST_SECRET` y
  `FIELD_ENCRYPTION_*` se pasan en la propia línea de la orden (o en una subshell que se cierra al
  terminar), **nunca** en un `.env` permanente ni en el perfil del shell. Borrar el CSV exportado
  cuando ya no haga falta.
- **Nada comercial sin doble opt-in.** La casilla solo guarda `commercialConsentRequested` y su
  fecha. De momento el doble opt-in es **manual**: César escribe a quien marcó la casilla
  pidiendo confirmación; si responde "Sí", conserva ese email y ejecuta
  `npm run waitlist:confirm-commercial -- --email <email>` (única vía que pone
  `commercialConsent=true` con fecha; solo funciona si se marcó la casilla). La casilla sola no
  basta: cualquiera puede escribir el email de otra persona en el formulario.
- **Retirada**: solo con `npm run waitlist:withdraw-commercial -- --email <email>` (o el futuro
  enlace de baja), nunca desde el formulario. Borra consentimiento y solicitud y guarda
  `commercialConsentWithdrawnAt`.
- El CSV de `waitlist:export` incluye `commercialConsentRequested(At)`, `commercialConsent(At)` y
  `commercialConsentWithdrawnAt`: solo se puede enviar algo comercial a filas con
  `commercialConsent=true`.
- Purga: ver la tarea programada en `ops/PILOT_RUNBOOK.md`.
