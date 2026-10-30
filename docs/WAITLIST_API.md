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
- Llamar **directamente** a la API de Render. Hasta el 26/10/2026 la web de la app pasaba por un
  *rewrite* de Vercel; desde entonces no hay ningún proxy propio delante de la API (ni la landing ni
  la app lo usan).
- `TRUST_PROXY` en producción es una **lista** (`loopback` + rangos de Cloudflare, que Render usa
  delante de sus servicios), no un número de saltos. Si cambia el dominio o se añade otro proxy,
  revisar la lista y repetir la comprobación directa de `req.ip` (ver `ops/PILOT_RUNBOOK.md`).

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
| `phone` | string | **sí** | máx. 25 caracteres. Se envía tal como lo teclea la persona; la API lo valida y lo guarda cifrado en E.164 (`+34612345678`). Se ignoran espacios, puntos, guiones y paréntesis. España: 9 dígitos de móvil (`6xx`, `71x`–`74x`) o fijo geográfico (`8[1-8]x`, `9[1-8]x`), con o sin `+34`/`0034`/`34`; se rechazan `70x`, `80x` y `90x`. Internacional: `+` o `00`, prefijo distinto de 34 y 8–15 dígitos en total. Sin `phone` (o vacío) → 400 `WAITLIST_PHONE_REQUIRED`; formato no válido → 400 `WAITLIST_PHONE_INVALID`. No es string o > 25 → 400 de validación genérico. Sin deduplicación por teléfono: un email ya apuntado que reenvía con teléfono recibe 202 y su fila no cambia |
| `situation` | enum | sí | `SELF_EMPLOYED` (autónomo/a) · `PRACTICE` (consulta/clínica) · `STUDENT` · `OTHER` |
| `tools` | string | no | máx. 500. Herramientas que usa hoy. La landing manda la opción elegida tal cual (`Doctoralia`, `Eholo`, `Excel / hojas de cálculo`, `Papel / agenda`, `Nada todavía`, `Otra`) o `Otra: <texto>` (texto de máx. 100). Sin caracteres de control (se admiten saltos de línea y tabulador) → si no, 400 |
| `professionalsCount` | entero | no | 1–500 |
| `source` | enum | no | `INSTAGRAM` · `COLLEAGUE` (un compañero) · `PROFESSIONAL_COLLEGE` (Colegio) · `SEARCH_ENGINE` (Google o Bing) · `OTHER` · `NOT_SAID` ("Prefiero no decirlo") |
| `privacyAccepted` | boolean | sí | debe ser `true` |
| `privacyPolicyVersion` | string | sí | la versión que muestra la página de privacidad: la landing envía `lista-espera-v5` con `phone` (desde el 27/10/2026). La API **solo acepta `lista-espera-v5`** (`ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS`). Las retiradas `lista-espera-v1` a `lista-espera-v4` (`RETIRED_WAITLIST_PRIVACY_POLICY_VERSIONS`) → 400 `WAITLIST_POLICY_VERSION_RETIRED`; cualquier otro valor → 400 de validación genérico. Se guarda tal cual; las altas ya guardadas con v2–v4 no cambian. Al cambiar de versión: **desplegar primero la API y después la landing**, y retirar la anterior cuando la landing ya no la sirva |
| `commercialConsentRequested` | boolean | no | **la landing ya no lo envía** (se quitó la casilla de novedades): sin el campo, la API guarda `false`. Se sigue aceptando por compatibilidad. Antes: casilla opcional, desmarcada por defecto (texto según la política `lista-espera-v2` de Lex Psi). Solo registra la **solicitud** con fecha; **no es un consentimiento válido** hasta el doble opt-in por email. Cualquier campo `commercialConsent*` distinto de este → 400. **`true` → 400 `WAITLIST_COMMERCIAL_NOT_OFFERED`** (la política vigente no ofrece comunicaciones comerciales; `false` o sin el campo, se acepta) |
| `formToken` | string | sí | el del paso 1 |
| `website` | string | no | honeypot: input de texto oculto con CSS (clase, no `style=`), `tabindex="-1"`, `autocomplete="off"`, `aria-hidden="true"`; siempre vacío |

> **Hecho (condición 3 de Argos, 27/10/2026):** `lista-espera-v2`, `lista-espera-v3` y
> `lista-espera-v4` se retiraron de `ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS` cuando la landing
> publicada ya enviaba `lista-espera-v5` con `phone`. Las altas ya guardadas con v2–v4 no cambian.

## Respuestas

| Estado | Cuerpo | Qué hacer en la landing |
|---|---|---|
| `202` | `{ "status": "accepted" }` | Mensaje de éxito genérico ("Si los datos son correctos, te escribiremos…"). Es la misma respuesta para alta nueva, email ya apuntado y honeypot: no decir "ya estabas apuntado/a". **Una segunda alta con el mismo email no cambia nada** (ni datos ni casilla comercial): si alguien quiere corregir datos o retirar el consentimiento, que escriba al email de contacto |
| `400` | `{ "statusCode": 400, "code": "WAITLIST_FORM_TOO_FAST", "message": "…" }` | Esperar `minSeconds` y reenviar automáticamente una vez |
| `400` | `{ "statusCode": 400, "code": "WAITLIST_FORM_TOKEN_INVALID", "message": "…" }` | Pedir otro token, esperar `minSeconds` y reenviar una vez |
| `400` | `{ "statusCode": 400, "code": "WAITLIST_PHONE_REQUIRED", "message": "…" }` | Error junto al campo teléfono: «Escribe tu teléfono: lo necesitamos para llamarte y contarte el piloto.» y foco en el campo |
| `400` | `{ "statusCode": 400, "code": "WAITLIST_PHONE_INVALID", "message": "…" }` | Error junto al campo teléfono: «Escribe un teléfono válido, por ejemplo 612 345 678 o +34 612 345 678.» y foco en el campo |
| `400` | `{ "statusCode": 400, "code": "WAITLIST_POLICY_VERSION_RETIRED", "message": "…" }` | La página envía una versión retirada (v1–v4), p. ej. una copia antigua en caché: pedir que recargue la página. No debería ocurrir con la landing publicada |
| `400` | `{ "statusCode": 400, "code": "WAITLIST_COMMERCIAL_NOT_OFFERED", "message": "…" }` | Fallo de la página (envía `commercialConsentRequested: true`): mensaje genérico de error. No debería ocurrir |
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
npm run waitlist:export -- --out ~/ruta/privada/lista-espera.csv   # fuera del repo; no sobrescribe; SIN teléfono
npm run waitlist:export -- --out ~/ruta/privada/lista-espera.csv --with-phone   # solo si hace falta el teléfono
npm run waitlist:delete -- --email persona@example.com             # supresión
npm run waitlist:purge -- --dry-run                                # purga por plazo (12 meses)
npm run waitlist:confirm-commercial -- --email persona@example.com # tras su "Sí" por email
npm run waitlist:withdraw-commercial -- --email persona@example.com
printf '%s\n%s\n' "$WL_EMAIL" "$WL_PHONE" | npm run waitlist:set-phone       # registrar/corregir teléfono (por stdin)
printf '%s\n' "$WL_EMAIL" | npm run waitlist:set-phone -- --clear           # borrar SOLO el teléfono
```

`waitlist:set-phone` no acepta el email ni el teléfono como argumentos (quedarían en el historial y
en la lista de procesos): se leen con `read -rs WL_EMAIL; read -rs WL_PHONE` y se pasan por stdin
(o el CLI los pide sin mostrarlos si se lanza en una terminal). `--allow-dev-secret` solo se admite
con una `DATABASE_URL` local (localhost, 127.0.0.1, ::1 o *.localhost). Cada export deja
`PLATFORM_WAITLIST_EXPORTED` (recuento y si lleva teléfono) en `PlatformAuditLog`. Ver ops/PILOT_RUNBOOK.md.

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
