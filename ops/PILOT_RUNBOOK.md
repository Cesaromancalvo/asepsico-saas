# Runbook de piloto de AsePsico

## Antes de incorporar usuarios

1. Confirmar HTTPS, dominio y cookies seguras.
2. Ejecutar migraciones y generar Prisma Client.
3. Crear un backup y restaurarlo en una base aislada.
4. Verificar cuentas, roles, consentimiento y pacientes de prueba.
5. Ejecutar typecheck, tests de seguridad y smoke test.
6. Confirmar responsable de incidencias y ventana de soporte.
7. **Bloqueante:** comprobación directa de la IP del cliente (sección "Comprobación directa de
   `req.ip`" más abajo) con resultado "coincide" y anotado en el registro del piloto.

## Topología de producción y IP del cliente

```
navegador ──HTTPS──> Vercel (apps/web, Next.js)
navegador ──HTTPS──> Cloudflare ──> balanceador de Render (termina TLS) ──HTTP──> API NestJS
                                                                   (servicio web asepsico-api, Frankfurt)
API ──red privada de Render──> Render Postgres (PG18, Frankfurt)
```

- El frontend en Vercel llama a la API desde el navegador (CORS limitado a `WEB_ORIGIN`), así que
  la IP que ve la API es la del navegador del usuario, no la de Vercel.
- Render documenta que el puerto del servicio **no es accesible directamente desde Internet**: todo
  el tráfico entra por su balanceador, que termina TLS y reenvía por HTTP. La IP real se lee de
  `X-Forwarded-For`; Render **añade** a esa cabecera, no la reinicia, de modo que las entradas de
  la izquierda las puede escribir el cliente.
- Por eso la API confía en **exactamente un salto** (`TRUST_PROXY=1`): `req.ip` es la entrada más
  a la derecha, la que pone el proxy de Render. Nunca `true` (la API se niega a arrancar): con
  `true` `req.ip` sería la entrada más a la izquierda, inventable, y el `@Throttle` por IP de
  `/auth/login`, `/auth/register` y `/auth/login/mfa` se esquivaría cambiando la cabecera.
- Si algún día se pone otro proxy delante (Cloudflare propio con dominio personalizado en modo
  proxied, un CDN…), el número de saltos cambia: ver el checklist de cambios de DNS/dominio.
- Lo verificado en documentación oficial de Render es que el puerto no es accesible directamente
  y que la IP del cliente se lee de `X-Forwarded-For`. **No** está documentado cuántas entradas
  añade la cadena Cloudflare → balanceador de Render: por eso `TRUST_PROXY=1` se confirma con la
  comprobación directa de abajo, no se da por supuesto.

### Variables en el servicio web de Render

| Variable | Valor en producción | Nota |
|---|---|---|
| `NODE_ENV` | `production` | Cookies `secure` y `trust proxy` por defecto. |
| `TRUST_PROXY` | `1` | Explícito aunque coincide con el valor por defecto en producción. |
| `WAITLIST_SECRET` | secreto aleatorio (`openssl rand -base64 32`) | Obligatorio: sin él la API no arranca. **No se rota** (rompe la deduplicación y la supresión de las altas previas). Lista de espera (ver `docs/WAITLIST_API.md`). |
| `WAITLIST_ALLOWED_ORIGINS` | vacío | = `https://asepsico.es,https://www.asepsico.es`. Solo afecta a `/public/waitlist`. |

La API valida `TRUST_PROXY` al arrancar; un valor mal escrito hace fallar el despliegue (Render
mantiene la versión anterior en marcha). El log de arranque muestra
`trust proxy: 1 salto(s) de proxy de confianza`.

### Comprobación manual tras cada despliegue (sin secretos)

Usa un email **inexistente** y una contraseña inventada: no se exponen credenciales reales y no se
bloquea ninguna cuenta. Sustituye `API` por la URL pública de la API.

```bash
API="https://<url-publica-de-la-api>/api/v1"
BODY='{"email":"ratelimit-check@example.com","password":"no-es-una-password-real"}'

# 1) Seis intentos desde tu IP: los 5 primeros 401, el sexto 429.
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/auth/login" \
    -H 'Content-Type: application/json' -d "$BODY"
done

# 2) Inmediatamente después, con X-Forwarded-For inventado y distinto en cada intento:
#    TODOS deben seguir en 429. Si alguno devuelve 401, la cabecera del cliente está
#    cambiando la IP del throttle: parar el piloto y revisar TRUST_PROXY.
for fake in 203.0.113.1 203.0.113.2 203.0.113.3; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/auth/login" \
    -H 'Content-Type: application/json' -H "X-Forwarded-For: $fake" -d "$BODY"
done
```

3) Orientativo, **no sustituye** a la comprobación directa: sin esperar al minuto, un intento
   desde otra red (p. ej. el móvil con datos, sin wifi) debería devolver 401. Ojo: puede dar un
   falso "todo bien" si `req.ip` fuera la IP del edge de Cloudflare, porque dos redes distintas
   suelen entrar por edges distintos y no comparten contador aunque la configuración sea errónea.

No pegues en tickets ni en el repo las respuestas completas ni cabeceras con cookies.

### Comprobación directa de `req.ip` (bloqueante antes del piloto)

Objetivo: confirmar que la IP que la API guarda es **la del operador**, no la de un proxy. Se hace
tras el primer despliegue con `TRUST_PROXY=1` y tras cualquier cambio de DNS/dominio o de
`TRUST_PROXY`.

**Por qué también es RGPD:** `req.ip` es la IP que la API registra junto a cada sesión
(`RefreshToken.ipAddress`, rellenado desde `meta()` en `apps/api/src/auth/auth.controller.ts`).
`AuditLog` tiene la columna `ipAddress`; hoy ningún código la rellena, pero si se rellena saldrá
de `req.ip` igual. Si `req.ip` fuera la IP de un proxy, la trazabilidad de accesos (quién entró y
desde dónde) sería inservible ante un incidente o una solicitud del titular; si fuera una entrada
inventable, sería falsificable.

Requisitos: una **cuenta de prueba ficticia** del workspace de pruebas (nunca la de un profesional
real ni datos de pacientes) y acceso de lectura a la BD de producción. Es solo lectura, pero es
acceso a producción: pedir confirmación al Jefe antes.

1. Desde el equipo del operador, inicia sesión con la cuenta de prueba en la web de producción
   (completando el MFA si el rol lo exige): el `RefreshToken` se crea al terminar el login.
2. En la misma red y sin VPN, ejecuta lo siguiente. No imprime ni la IP ni la URL de la BD; la
   URL externa de la BD se copia del panel de Render y se lee sin eco, así no queda en el
   historial:

```bash
read -rs PROD_DB_URL   # pegar la "External Database URL" de Render y pulsar Enter
TEST_EMAIL='cuenta-de-prueba@example.com'   # la cuenta ficticia usada en el paso 1

MY_IP4=$(curl -4 -s https://api.ipify.org || true)
MY_IP6=$(curl -6 -s https://api6.ipify.org || true)

# Consulta de solo lectura: la sesión de psql no puede escribir.
DB_IP=$(printf '%s\n' "SELECT rt.\"ipAddress\" FROM \"RefreshToken\" rt JOIN \"User\" u ON u.id = rt.\"userId\" WHERE u.email = :'email' ORDER BY rt.\"createdAt\" DESC LIMIT 1;" \
  | PGOPTIONS='-c default_transaction_read_only=on' psql "$PROD_DB_URL" -X -q -At -v email="$TEST_EMAIL")
DB_IP=${DB_IP#::ffff:}
unset PROD_DB_URL

if [ -z "$DB_IP" ]; then echo "SIN DATO: no hay sesión reciente de la cuenta de prueba";
elif [ "$DB_IP" = "$MY_IP4" ] || [ "$DB_IP" = "$MY_IP6" ]; then echo "COINCIDE: TRUST_PROXY correcto";
else
  echo "NO COINCIDE"
  { curl -s https://www.cloudflare.com/ips-v4; echo; curl -s https://www.cloudflare.com/ips-v6; } \
    | DB_IP="$DB_IP" python3 -c 'import ipaddress,os,sys; ip=ipaddress.ip_address(os.environ["DB_IP"]); print("ES DE CLOUDFLARE" if any(ip in ipaddress.ip_network(l.strip()) for l in sys.stdin if l.strip()) else "NO ES DE CLOUDFLARE")'
fi
unset DB_IP MY_IP4 MY_IP6
```

3. Interpretación:
   - **COINCIDE** → `TRUST_PROXY=1` es correcto. Anotar en el registro del piloto: fecha,
     "comprobación directa de req.ip: coincide, TRUST_PROXY=1". **Nunca anotar la IP.**
   - **NO COINCIDE + ES DE CLOUDFLARE** → hay un salto más de los configurados (todos los usuarios
     entrando por el mismo edge compartirían contador). Con confirmación del Jefe: poner
     `TRUST_PROXY=2` en Render, redesplegar, repetir los pasos 1 y 2 de la comprobación anterior
     (deben seguir en 429: con 2 saltos la entrada que escribe el cliente sigue sin ser de
     confianza) y repetir esta comprobación hasta obtener COINCIDE. Rollback: volver a
     `TRUST_PROXY=1`.
   - **NO COINCIDE + NO ES DE CLOUDFLARE** (u otro resultado raro, p. ej. IP privada de Render) →
     no abrir el piloto; escalar a Dora/Argos con el resultado, sin la IP.
   - **SIN DATO** → el login no terminó o se usó otra cuenta; repetir el paso 1.

### Checklist de cambios de DNS / dominio personalizado (bloqueante)

Antes de dar por cerrado cualquier cambio de dominio o DNS de la API:

- [ ] ¿El dominio de la API pasa por un Cloudflare **propio** en modo *proxied* (nube naranja), un
      CDN u otro proxy? Si es así, **añade un salto**: con `TRUST_PROXY=1` la API vería la IP de
      ese proxy y todos los usuarios compartirían el límite de login.
- [ ] Repetir la comprobación manual (pasos 1 y 2) y la comprobación directa de `req.ip` antes de
      enrutar tráfico real por el dominio nuevo, y ajustar `TRUST_PROXY` según el resultado.
- [ ] Actualizar `WEB_ORIGIN`/`COOKIE_DOMAIN` si cambia el dominio, y anotar el resultado (sin IPs).

### Trabajo futuro (no implementado)

- **Límite por email en `/auth/login`.** El límite actual es por IP. Conviene añadir un límite por
  email (normalizado) además del de IP, para frenar el credential stuffing distribuido desde
  muchas IPs contra una misma cuenta, con respuesta idéntica exista o no la cuenta para no
  permitir enumeración.
- **Opción `CF-Connecting-IP`.** Si Render confirmara por escrito (documentación o soporte) que
  **todo** el tráfico pasa por Cloudflare y que esa cabecera la fija Cloudflare sobrescribiendo
  la del cliente, se podría ofrecer como fuente de la IP en lugar de contar saltos. Hoy Render no
  la documenta, así que no se usa.
- **Paso `verify-mfa-concurrency` del CI.** Cuando `scripts/verify-mfa-concurrency.mjs` esté en
  `main` (PR #9), quitar la condición "si existe el script" del paso de
  `.github/workflows/ci.yml` para que su ausencia vuelva a hacer fallar el job.

## Importación de pacientes: comportamientos conocidos (Argos, B1 y B2)

Solo puede importar un profesional clínico según la BD (criterio de E1: THERAPIST siempre;
OWNER/ADMIN solo con `isClinician`; ASSISTANT nunca). Cada intento denegado queda auditado como
`PATIENT_IMPORT_FORBIDDEN` con el rol y la operación, sin datos del fichero.

- **B1. El permiso se comprueba al empezar el lote, no bloque a bloque.** La confirmación
  comprueba el permiso una vez, al empezar, y después procesa el lote por bloques. Si a alguien
  le quitan el rol clínico (o lo pasan a ASSISTANT) con una confirmación en curso, esa confirmación
  termina. Las llamadas siguientes (reintentar un lote PARTIAL, deshacer, ver, listar) sí reciben
  403. Si hay que cortar un lote en marcha, retirar el permiso no basta: hay que esperar a que
  termine y deshacerlo, o seguir el apartado "Incidente".
- **B2. Un OWNER/ADMIN al que le quitan `isClinician` ya no puede deshacer sus lotes.** Deshacer
  pasa por la misma comprobación: recibe 403 (auditado) aunque el lote sea suyo y siga dentro de
  la ventana de 7 días. Los pacientes y procesos importados se quedan. Antes de quitar
  `isClinician` a un OWNER/ADMIN, revisar si tiene lotes recientes que quiera deshacer y hacerlo
  primero. Si ya se le quitó, decidir con el responsable del piloto cómo seguir (por ejemplo,
  devolverle `isClinician` de forma temporal y auditada para deshacer); no hay un deshacer
  administrativo.

## Baja de un miembro: notas internas del profesional anterior

- Al reasignar los procesos de un profesional dado de baja, sus notas internas se archivan en
  `ClinicalProcessPrivateNote` (cifradas, con su autor). **Hoy no tienen ninguna vía de lectura**:
  ningún endpoint ni exportación devuelve su contenido (la exportación del workspace solo da el
  recuento `archivedPrivateNotes`) y **nadie las lee consultando la BD directamente** (tampoco el
  operador de la plataforma).
- Su devolución a la consulta depende de la futura exportación clínica completa **H1**: mismo
  apartado que las `internalNotes` vivas, con autor, solo OWNER con reautenticación, auditoría por
  proceso (ids) y siempre excluidas de la exportación del paciente (art. 18.3 Ley 41/2002) y de la
  de un THERAPIST. **H1 es requisito antes de que un cliente real se dé de baja o pida la
  devolución de sus datos.**

## Alta por QR: caducidad de las solicitudes (14 días)

- Las solicitudes de alta en el portal (`PortalSignupRequest`) sin respuesta caducan a los 14 días y
  se **borran** con auditoría `PORTAL_SIGNUP_REQUEST_EXPIRED` (solo ids, sin datos personales).
- **Purga automática dentro de la API** (`PortalSignupCleanupService`), sin coste ni cron externo:
  una vez unos 10 s después de arrancar (sin bloquear el arranque) y después **cada hora**, en todos
  los espacios. Es idempotente (varias instancias a la vez no son un problema) y no hace nada con
  `NODE_ENV=test`. Si falla, solo deja un aviso en el log con el tipo de error
  (`Purga de solicitudes de alta fallida (...)`), nunca datos. Si ese aviso se repite, revisar la
  conexión a la base de datos y lanzar la purga manual.
- Además, la API purga las de un espacio cada vez que alguien lista o recibe solicitudes de ese espacio.
- **Respaldo manual** (todos los espacios): `npm run portal-signup:purge`. Solo necesita
  `DATABASE_URL`, es idempotente y solo imprime el recuento. Se ejecuta desde el clon de despliegue
  con la URL leída con `read -rs` (como los CLI de la lista de espera) y `unset` al terminar. Ya no
  hace falta ejecutarla cada semana: solo si el aviso de fallo se repite o tras una caída larga.
- No se usa GitHub Actions para esta purga: el repositorio es público y exigiría guardar
  `DATABASE_URL` de producción en GitHub y abrir la base a las IP de los runners.

## Backups

- Frecuencia recomendada para piloto: diaria.
- Retención inicial: 30 días.
- Cifrado: el volumen o repositorio de destino debe estar cifrado.
- Prueba de restauración: semanal durante el piloto.
- Nunca guardar dumps en el repositorio Git.

## Incidente

1. Detener la operación afectada sin borrar evidencias.
2. Registrar hora, alcance, usuarios y datos potencialmente afectados.
3. Rotar secretos cuando exista sospecha de compromiso.
4. Restaurar únicamente desde una copia verificada.
5. Documentar causa, corrección y medidas preventivas.

## Lista de espera pública (asepsico.es)

Contrato y detalles en `docs/WAITLIST_API.md`.

- **Host de la API para la landing: a confirmar por Dora** (`asepsico-api.onrender.com` no está
  verificado). Es configurable en la landing y debe coincidir con `connect-src` de su CSP.
- **Casilla de novedades retirada (política `lista-espera-v3`, desde el 17/10/2026).** No se envía
  **nada comercial** (ni novedades ni ofertas) a nadie de la lista de espera: solo mensajes sobre su
  solicitud y el piloto. La marca `commercialConsentRequested` de las altas anteriores (v2) se borra
  por decisión de producto; anotar la fecha de ejecución en el registro del piloto (sin datos
  personales). `waitlist:confirm-commercial` y `waitlist:withdraw-commercial` siguen existiendo por
  compatibilidad, pero **no se ejecutan**. Un segundo envío del formulario con el mismo email no
  cambia nada.
- **Claves de producción solo en ejecuciones puntuales de los CLI** (`waitlist:export`,
  `waitlist:delete`, `waitlist:purge`): se pasan en la línea de la orden y se descartan al
  terminar; nunca en un `.env` permanente, en el perfil del shell ni en el repo.
- **`WAITLIST_SECRET` no se rota.**

### Aviso por correo de altas nuevas (Scaleway Transactional Email)

Cuando alguien se apunta, la API envía al Jefe un correo **sin datos del apuntado** con asunto
«Nuevo apunte en la lista de espera»: cuántas altas nuevas hay, el total activo, la fecha y cómo
consultarlas (`waitlist:export`). Como mucho **1 aviso cada 10 minutos** con el recuento acumulado.
Las altas repetidas y el honeypot no avisan. Está **apagado por defecto**.

**Activarlo (una vez):**
1. En Scaleway (región fr-par), comprobar que el dominio `notificaciones.asepsico.es` aparece como
   verificado en Transactional Email. Mientras no lo esté, los envíos fallan (solo queda un aviso en el log).
2. Crear una **API key** asociada a una aplicación IAM con una política que dé solo
   `TransactionalEmailEmailSmtpCreate` (enviar por SMTP; es el mínimo, preferible a
   `TransactionalEmailFullAccess`) y **solo** sobre el proyecto `asepsico-prod`. Ningún otro permiso.
   Anotar en el registro del piloto la fecha y el ID de la clave (nunca la clave secreta). El ID del
   proyecto (para `MAIL_SMTP_USER`) está en Transactional Email → dominio → Overview (credenciales
   SMTP) y en Project Dashboard → Settings.
3. En Render → servicio de la API → Environment:
   - `MAIL_SMTP_HOST=smtp.tem.scaleway.com`
   - `MAIL_SMTP_PORT=2465` (TLS implícito). **No usar 587 ni 465 en el plan gratuito de Render:** desde
     septiembre de 2025 bloquea la salida a los puertos SMTP 25, 465 y 587 y el aviso nunca llega (en el
     log sale `Aviso de lista de espera no enviado (Error ETIMEDOUT)` o similar a los ~15 s). Scaleway
     acepta los alternativos 2465 (TLS implícito) y 2587 (STARTTLS); la API admite 587, 465, 2587 y
     2465, siempre con TLS ≥ 1.2 y certificado verificado. En un plan de pago de Render vale cualquiera.
   - `MAIL_SMTP_USER=` ID del proyecto `asepsico-prod`
   - `MAIL_SMTP_PASSWORD=` clave secreta de la API key (se pega una vez y no se vuelve a mostrar)
   - `MAIL_FROM=AsePsico <avisos@notificaciones.asepsico.es>`
   - `WAITLIST_NOTIFY_TO=` el correo del Jefe
   - `WAITLIST_NOTIFY_ENABLED=true`
4. Guardar y dejar que Render redespliegue. Si falta algo, la API **no arranca** y el log dice qué
   variable falta (sin mostrar valores): corregir y volver a guardar.

**Probarlo:** apuntarse en la landing con un correo de prueba propio. En menos de un minuto llega el
aviso. Después, borrar esa alta con `npm run waitlist:delete -- --email <correo de prueba>`. Si no
llega: buscar en el log de Render `Aviso de lista de espera no enviado (...)` (solo trae el tipo y el
código de error; `ETIMEDOUT`/`ECONNECTION` suele ser un puerto bloqueado: comprobar `MAIL_SMTP_PORT=2465`)
y revisar el panel de Scaleway (dominio verificado, cuota, clave).

**Rotar la clave** (cada 6–12 meses, o ya si se sospecha una fuga): crear una API key nueva con la
misma política → cambiar `MAIL_SMTP_PASSWORD` en Render → probar con un alta de prueba → **borrar la
clave antigua** en Scaleway → anotar la fecha en el registro del piloto.

**Apagarlo:** `WAITLIST_NOTIFY_ENABLED=false` en Render (el resto de variables puede quedarse).

**Límites conocidos:** el agrupado vive en memoria. En el plan gratuito la API se duerme: un aviso
pendiente puede perderse al dormir o al reiniciar (aceptado: las altas siguen en la base de datos
y `waitlist:export` las muestra todas). Un fallo de envío se reintenta una sola vez; nunca afecta al alta.

### Panel privado de la lista de espera (`/admin/lista-espera`)

Sustituye al uso diario de `waitlist:export` / `waitlist:delete` (los CLI siguen valiendo). Solo lo
ve quien esté en `PLATFORM_ADMIN_EMAILS` **y** tenga el MFA activo; para cualquier otro la API
responde 404. **No activarlo en producción hasta que la landing publique `lista-espera-v4`.**

**1. Crear la cuenta exclusiva de administración (una vez).** No uses tu cuenta de una consulta ni la
del demo: el panel ve datos personales y esa cuenta debe servir solo para esto.
1. Elegir un correo propio que no tenga ya cuenta en AsePsico (p. ej. un alias tuyo dedicado).
2. `DATABASE_URL=… WEB_ORIGIN=https://<web> npm run invites:create -- --email <ese correo> --created-by cli:cesar`
   (orden puntual, sin `.env` permanente; el enlace sale una vez).
3. Abrir el enlace y registrarse con ese correo, una contraseña larga y única (gestor de
   contraseñas) y como nombre del espacio **«AsePsico interno»**. Si el formulario pregunta si atiendes pacientes, responder que no.
   No crear pacientes ni invitar a nadie en ese espacio: debe quedarse vacío.
4. Activar la verificación en dos pasos (la app la exige al OWNER) y guardar los códigos de
   recuperación en el gestor de contraseñas.

**2. Activar la variable.** En Render → servicio de la API → Environment:
`PLATFORM_ADMIN_EMAILS=<el correo de la cuenta exclusiva>` (uno solo; nunca el de una cuenta de
consulta). Guardar y dejar que redespliegue. Sin la variable, o vacía, nadie entra.

**3. Comprobar.** Con la cuenta exclusiva: el menú de usuario muestra «Lista de espera» y
`/admin/lista-espera` carga. Con cualquier otra cuenta: sin enlace y 404. Desactivar el MFA de la
cuenta exclusiva quita el acceso al momento (volver a activarlo para recuperarlo).

**Uso.** Suprimir un alta pide tu contraseña y no se puede deshacer (misma supresión que
`waitlist:delete`). Cada consulta y cada supresión quedan en `PlatformAuditLog` sin datos
personales (consulta por SQL de solo lectura si hace falta). No copies datos fuera del panel.

**Quitar el acceso:** borrar o vaciar `PLATFORM_ADMIN_EMAILS` en Render (redespliega) o desactivar
el MFA de la cuenta. Si se sospecha que la cuenta exclusiva está comprometida: vaciar la variable
primero, después cambiar la contraseña (cierra todas sus sesiones) y regenerar el MFA.

### Tarea programada: purga por plazo de conservación

| Cuándo | Qué |
|---|---|
| El día 1 de cada mes **a partir del 01/10/2027** (12 meses después de las primeras altas posibles) | `DATABASE_URL=… npm run waitlist:purge -- --dry-run` y, si el recuento cuadra, `DATABASE_URL=… npm run waitlist:purge` (suprime las altas de hace más de 12 meses) |
| **3 meses después del lanzamiento público** (anotar la fecha aquí cuando se conozca: ____) | `DATABASE_URL=… npm run waitlist:purge -- --older-than-months 0` (suprime todas las altas activas que queden) |

La purga vacía todos los datos personales y el hash del email (queda solo `deletedAt`). El
comando solo imprime recuentos. Anotar fecha y número de altas suprimidas en el registro del piloto.

