# Sprint 19 — Salida de Vercel, web estática y arreglos previos al piloto demo (27/10/2026)

## Objetivo

Dejar la aplicación lista para las primeras altas del piloto demo (solo datos inventados):

1. **Servir la web de la app sin Vercel**: export estático en Render Static Site (`app.asepsico.es`) que llama directamente a la API (`api.asepsico.es`), sin proxy intermedio.
2. **Corregir las cookies** que dejaba el cambio de dominio, también en el portal del paciente.
3. **Arreglos P0 de pantalla y API** detectados al preparar el manual de onboarding del piloto.
4. **Política de privacidad para profesionales demo-1.2**, sin Vercel como proveedor.
5. **Teléfono obligatorio en la lista de espera** de la web pública, con su política `lista-espera-v5`.

Este documento registra lo fusionado en `main` el 27/10/2026 con los PR #43 a #47 (HEAD `1930b55`). No declara nada como validado para datos clínicos reales.

Numeración: el último documento de sprint es el 18 (entrega S5). Los PR #35 a #42 (aviso y política v4 de la lista de espera, SEO de la landing, arreglos de tareas, puertos SMTP y panel privado de la lista de espera) se fusionaron entre el 21 y el 24/10 sin documento propio; esta entrega toma el número **19**.

## Qué incluye

### PR #43 — Salida de Vercel: web estática en `app.asepsico.es` (merge `cdb056f`)

**Web (`apps/web`)**

- `next.config.mjs` con `output: 'export'` y `trailingSlash: true`; fuera los `rewrites` hacia la API y la variable `API_INTERNAL_URL`. La web llama directamente a `NEXT_PUBLIC_API_URL`. Se quita el script `start` (no aplica a un export) y se añade `postbuild` (`scripts/csp-hashes.mjs`).
- **Rutas fijas con el id en la query**: las 9 rutas dinámicas pasan a `/patients/view/?id=…`, `/patients/view/<sección>/?id=…`, `/patients/view/process/?id=…&processId=…` y `/agenda/session/?id=…`. `lib/routes.ts` centraliza las URL y traduce el formato antiguo (que aún genera la API en la línea temporal y que puede haber en marcadores); el 404 redirige las URL antiguas (`LegacyRedirect`).
- **Ids validados** (`queryId`): solo se aceptan ids con forma de cuid antes de interpolarlos en rutas de la API (`QueryIdGuard`).
- **CSP con hashes por página** (meta CSP generada tras el build) y enlaces del QR y de la activación con barra final.
- Comprobaciones nuevas: `apps/web/test/static-export.spec.ts`, `apps/web/test/routes.spec.ts`, `apps/web/test/csp-hashes.spec.ts`, paso de CI `scripts/check-web-static-export.mjs` (impide que vuelvan `standalone`, `rewrites` o `API_INTERNAL_URL`) y `npm run verify:static-site` (cabeceras y CSP de la web publicada).

**API (`apps/api`)**

- Cookies de sesión host-only de la API; solo `csrf_token` lleva `COOKIE_DOMAIN` para que la web la lea. Limpieza de las cookies antiguas con `Domain` al iniciar sesión, refrescar, verificar el MFA y cerrar sesión (`auth/cookie.util.ts`).
- **Portal del paciente arreglado**: su `csrf_token` también se emite con `COOKIE_DOMAIN`; sin ello el portal respondía 403 desde `app.asepsico.es` (`portal/portal.controller.ts`).
- Tests: `auth-cookies-domain.security-spec.ts`, `auth-cookies-legacy-domain.security-spec.ts` y casos nuevos en `portal.security-spec.ts`.

**Documentación**: `ops/PILOT_RUNBOOK.md`, `docs/SECURITY_BASELINE.md`, `docs/WAITLIST_API.md` y `.env.example` con la topología sin Vercel. Sin migraciones.

### PR #44 — Arreglos P0 de la API (merge `2b02c7f`)

- **A2:** los cobros nuevos se numeran `COB-AAAA-NNNN` en lugar de `FAC-`, para que no parezcan un número de factura; los avisos dicen «Cobro». Los cobros existentes conservan su número. Sin migración (`billing/billing.service.ts`).
- **A7:** la interpretación de las escalas sembradas en el espacio demo lleva la marca «[Ejemplo ficticio]» (`prisma/scripts/demo/demo-writer.ts`).

### PR #45 — Arreglos P0 de la web (merge `d2baa9f`)

- **A1:** el portal del paciente deja de ofrecer preferencias de avisos por correo o SMS, que no existen.
- **A3:** «Primeros pasos» del inicio pasa a 3 pasos (perfil, primer paciente y primera cita); fuera «Recordatorios revisados» (`dashboard/dashboard.service.ts`).
- **A4:** fuera el texto técnico sobre el almacenamiento de archivos; recursos y documentos dicen «Hoy no se pueden subir archivos: los recursos y los documentos se comparten como enlaces o se registran sus datos.»
- **A5:** estilos del formulario «Programar una cita» (y del alta de recursos, que comparte clases).
- **A6:** el ejemplo de «Notas» de la cita es de organización, no clínico.

### PR #46 — Privacidad para profesionales demo-1.2 (merge `a453e18`)

- `PRIVACY_PRODUCT` pasa a `demo-1.2`, en vigor desde el 27/10/2026, sin Vercel como proveedor (`legal/legal-documents.ts`, `legal/texts/privacy-product.ts`). Las condiciones del piloto siguen en `demo-1.1`.
- Control de marcadores: ningún texto legal cargado puede llevar huecos entre corchetes salvo los de datos del titular que pone el despliegue.

### PR #47 — Teléfono en la lista de espera, política v5, botón «Acceder» y panel (merge `1930b55`)

- **API:** teléfono **obligatorio** con la política `lista-espera-v5` (rechazado con v2–v4), normalizado a E.164 y cifrado en reposo. Borrado solo del teléfono (panel y CLI `npm run waitlist:set-phone`, auditado), CSV sin teléfono por defecto y exportación auditada. Migración aditiva `20261027201255_waitlist_phone` (columna `phone` opcional). Detalle de las garantías en `docs/SECURITY_BASELINE.md` (sección de la lista de espera).
- **Landing:** campo de teléfono obligatorio, política v5 publicada en `/privacidad-lista-espera/` y v4 archivada en `/v4/`; botón «Acceder» al final de la cabecera hacia la app.
- **Panel privado de la lista de espera:** columna de teléfono, contador de inscripciones sin teléfono y «Borrar solo el teléfono».
- Tests: `waitlist-phone.security-spec.ts`, `waitlist-phone-db.security-spec.ts`, `apps/web/test/platform-waitlist.spec.tsx` y `scripts/check-landing-form.mjs`.

## Seguridad

- La salida de Vercel elimina un intermediario en el camino de las peticiones a la API. La topología resultante, sus riesgos conocidos y las condiciones de la revisión de seguridad están en `docs/SECURITY_BASELINE.md` y `ops/PILOT_RUNBOOK.md`; este documento no añade nada a lo que ya recogen.
- Cookies: las de sesión no salen del host de la API; la limpieza de las antiguas evita revocaciones en cadena por convivir dos cookies con el mismo nombre.
- Los ids de la query se validan antes de usarse en rutas de la API.
- El teléfono de la lista de espera se trata como el email (cifrado, fuera de logs y auditorías).
- Revisión de seguridad (Argos): los PR #44, #45 y #47 constan como aprobados en su descripción (#47 también por la revisión legal); el #43 incorpora las condiciones de la revisión C4 (test del export estático, CSP con hashes, cookies host-only y validación de ids). El #46 no tiene descripción en el PR.
- Sin datos reales en código, tests ni seeds.

## Decisiones técnicas

- **Export estático en lugar de servidor Next**: la app no necesita renderizado en servidor y así la web y la API las sirve el mismo proveedor, sin proxy. Coste: las rutas con id pasan a query string y hay que traducir las URL antiguas.
- **Id en la query validado con forma de cuid**: evita que un id manipulado redirija la llamada a otro endpoint de la API.
- **`COB-` sin migración**: solo cambia el prefijo de los cobros nuevos; los antiguos se conservan para no reescribir referencias ya emitidas.
- **Teléfono opcional en el esquema y obligatorio por política**: la columna admite nulos para las inscripciones previas a la v5; la obligatoriedad la impone la validación según la versión de la política aceptada.

## Evidencia

- **CI:** los dos checks (`Typecheck, tests and build` y `PostgreSQL migrations and real HTTP smoke test`) en verde en el último commit de cada PR (`228dcff`, `3a8df1d`, `a1752f3`, `254cbb8`, `0cea741`) y en el merge final `1930b55` (consulta a la API pública de GitHub, 28/10/2026).
- **Cifras de tests:** no recogidas en este documento; no se han aportado recuentos por suite de esta entrega.
- **Entorno (comunicado por coordinación, sin acta en el repositorio):** proyecto de Vercel borrado y ensayo de alta completo del piloto demo (invitación, registro, verificación en dos pasos, aceptación de condiciones y carga de pacientes inventados) correcto el 27/10/2026.

## Pendiente

- **Antes de la primera alta real del piloto demo:** confirmar en producción los arreglos P0 (#44 y #45) y la privacidad demo-1.2; capturas del manual rehechas con las pantallas nuevas; procedimiento de restablecimiento de contraseña y de verificación en dos pasos por soporte (la app no tiene «He olvidado mi contraseña»).
- **Antes del primer paciente real:** riesgo M1 de `TRUST_PROXY` (ver `ops/PILOT_RUNBOOK.md`), revisión por abogado de los textos legales (demo-1.1 y demo-1.2 son borradores) y el resto de la Fase B del roadmap.
- **Producto:** la línea temporal y el panel de la API siguen generando URL con el formato antiguo, que la web traduce; conviene que la API genere ya el formato nuevo. Las condiciones demo-1.1 dicen que el espacio se crea con pacientes inventados, pero tras el alta empieza vacío y se cargan después: alinear en su versión final.

## Criterio de aprobación

La entrega queda **Implementada** en `main` con el CI en verde. Pasará a validada para el piloto demo cuando conste por escrito, en producción:

- la web de la app servida como sitio estático con `npm run verify:static-site` correcto;
- inicio de sesión de profesional y de paciente sin 401/403 por cookies;
- cobros nuevos con `COB-`, portal sin preferencias de avisos y «Primeros pasos» con 3 pasos;
- privacidad `demo-1.2` visible en `/legal`;
- formulario de la lista de espera con teléfono obligatorio y política v5 publicada.
