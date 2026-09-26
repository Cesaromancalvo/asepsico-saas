# Runbook de piloto de AsePsico

## Antes de incorporar usuarios

1. Confirmar HTTPS, dominio y cookies seguras.
2. Ejecutar migraciones y generar Prisma Client.
3. Crear un backup y restaurarlo en una base aislada.
4. Verificar cuentas, roles, consentimiento y pacientes de prueba.
5. Ejecutar typecheck, tests de seguridad y smoke test.
6. Confirmar responsable de incidencias y ventana de soporte.

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
  proxied, un CDN…), el número de saltos cambia: repetir la comprobación de abajo **antes** de
  abrir el tráfico y ajustar `TRUST_PROXY`.

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

3) Sin esperar al minuto, repetir **un** intento desde otra red (p. ej. el móvil con datos, sin
   wifi): debe devolver 401, no 429. Si devuelve 429, todos los usuarios comparten IP (hay más
   saltos de los configurados) y 5 fallos bloquearían el login de todo el mundo: revisar
   `TRUST_PROXY`.

No pegues en tickets ni en el repo las respuestas completas ni cabeceras con cookies.

### Pendiente recomendado (no implementado)

El límite actual de `/auth/login` es por IP. Conviene añadir un límite por email (normalizado)
además del de IP, para frenar el credential stuffing distribuido desde muchas IPs contra una
misma cuenta, con respuesta idéntica exista o no la cuenta para no permitir enumeración.

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
