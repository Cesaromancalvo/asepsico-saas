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
