# Landing pública de AsePsico (asepsico.es)

Web estática de una sola página: HTML, CSS y un poco de JavaScript sin dependencias.
**No tiene `package.json`** a propósito: npm workspaces no la recoge, así que ni `npm ci`, ni el
typecheck ni el build del monorepo la tocan, y ella no depende de la app. El único "build" es
`build.mjs` (Node sin dependencias), que copia `public/` a `dist/` y rellena el NIF y el domicilio
del titular desde variables de entorno (ver "Datos del titular").

## Estructura

```
apps/landing/
  cambios.mjs              <- valida data/cambios.json y genera el HTML de /estado/ y /cambios/
  data/cambios.json        <- estado, incidencias y novedades (lo único que se edita para publicar un aviso)
  build.mjs                <- build de publicación: public/ → dist/ rellenando [[NIF]] y [[DOMICILIO]]
  borradores/              <- bloques NO publicados (p. ej. la calculadora); fuera de public/
  public/                  <- directorio que se publica
    index.html             <- la landing
    aviso-legal/index.html <- aviso legal (texto final de Argos)
    privacidad/index.html  <- política de privacidad y cookies (versión sin analítica)
    privacidad-lista-espera/index.html    <- política de la lista de espera v3 (formulario propio)
    privacidad-lista-espera/v2/index.html <- política v2 archivada (altas hechas con la versión lista-espera-v2; la v3 la enlaza); noindex
    privacidad-lista-espera/v1/index.html <- política v1 (Google Forms), solo para la red de seguridad; noindex
    css/styles.css
    js/config.js           <- enlaces, datos legales e interruptores (lo único que hay que tocar)
    js/main.js             <- acordeón, narrativa con scroll, aparición de secciones, interruptores, "lo que te cuesta hoy", formulario de la lista de espera
    estado/index.html      <- estado del servicio e incidencias (marcador [[ESTADO]], lo rellena build.mjs)
    cambios/index.html     <- cambios y avisos previos (marcador [[CAMBIOS]], lo rellena build.mjs)
    404.html               <- página de error propia (noindex, fuera del sitemap)
    fonts/                 <- Poppins autoalojada (woff2, subconjunto latino) + OFL.txt
    img/                   <- logo y og-image.png (1200x630)
    favicon.ico, favicon.png, apple-touch-icon.png, robots.txt, sitemap.xml
```

## Reglas de la landing

- **Ninguna petición a terceros**: fuentes, imágenes, iconos y scripts se sirven desde la propia web.
  Nada de `<iframe>`, Google Fonts, CDN, vídeos ni píxeles. Instagram (y el Google Form, solo si se
  apaga `FEATURES.ownWaitlistForm`) son **enlaces** normales (`target="_blank" rel="noopener noreferrer"`).
- **Única petición de red: la API propia de la lista de espera** (`WAITLIST_API_URL`), con `fetch`,
  `credentials: 'omit'` y solo cuando alguien usa el formulario (sección `#apuntate`). Contrato:
  `docs/WAITLIST_API.md`. El token se pide al enfocar el formulario (no al cargar la página) y no se
  envía antes de `minSeconds` (3 s). Tras el `202` el mensaje es siempre el mismo (no dice si el
  email ya estaba apuntado). Sin cookies, sin `localStorage`/`sessionStorage`.
- **Sin analítica** (decisión del Jefe, 01/10): la web no mide visitas ni clics y no usa cookies.
  El origen de las altas se pregunta en el formulario. El snippet de Plausible sigue comentado en el
  `<head>` por si algún día se activa (ver el comentario: habría que cambiar también la FAQ 5 y la
  política de privacidad).
- **Sin scripts ni estilos en línea**, para poder servirla con una CSP estricta (ver abajo).
- **Capturas**: de momento son mockups dibujados en HTML con datos ficticios y la etiqueta
  "Diseño / prototipo · datos ficticios" siempre visible. Las capturas reales (C1–C6) deben
  conservar esa etiqueta.
- **Textos**: solo frases de la lista de afirmaciones permitidas (privada, fuera del repo).

### Comprobación automática (CI)

`scripts/check-landing.mjs` (en el job `quality` de `.github/workflows/ci.yml`) falla si en
`apps/landing/public` aparece un dominio externo fuera de la lista permitida (`asepsico.es`,
`forms.gle`, `instagram.com`, y los que cita la política de la lista de espera: `policies.google.com`, `dataprivacyframework.gov`, `aepd.es`), un `<iframe>`/`<object>`/`<embed>`, estilos en línea (`style=`,
`<style>`), un `<script>` en línea, un manejador `on*=` o una URL `javascript:`. Ignora los
comentarios. El origen de la API (`CONNECT_ORIGINS`: `https://asepsico-api.onrender.com`, exacto,
sin subdominios) solo se admite en `js/config.js`. Además comprueba que la CSP de este README tiene
`connect-src 'self' https://asepsico-api.onrender.com` (ni más ni menos), `form-action 'none'` y
`'self'` en `default-src`, `script-src`, `style-src`, `img-src` y `font-src`. En `public/` los marcadores `[[NIF]]` y `[[DOMICILIO]]` son lo esperado (falla con
cualquier otro `[[...]]`); con `--require-filled` (salida del build) cualquier marcador es error.
`npm run test:landing` ejecuta además `scripts/check-landing-build.mjs`, que prueba `build.mjs` con
datos ficticios: salida sin marcadores y válida para la CSP, fallo cerrado sin variables o con
valores mal formados, y ningún valor escrito en el log.
`scripts/check-landing-form.mjs` prueba el formulario de la lista de espera con un DOM mínimo y un
`fetch` simulado (sin red): ninguna petición al cargar y un solo token aunque haya varios focos, espera de
`minSeconds`, tras el `202` campos vacíos y token descartado, el token no se reenvía tras 400/413/415/429,
reintentos únicos (`TOO_FAST`, `TOKEN_INVALID`), mensajes de 429, de red y de validación, `credentials:
'omit'` y ningún acceso a `localStorage`, `sessionStorage` ni cookies.
Excepción: los bloques `<script type="application/ld+json">` (datos estructurados) se permiten si
son JSON válido, no llevan `src` y solo contienen URLs de la propia web o el identificador
`https://schema.org` (que no se descarga). Fuera del JSON-LD, `schema.org` no está permitido.
No hace falta tocar la CSP: un bloque de datos no se ejecuta.

```bash
npm run test:landing
```

Si se añade un dominio nuevo (por ejemplo, el de la política del formulario), hay que añadirlo a
`ALLOWED_HOSTS` en ese script.

## Estado y cambios (`data/cambios.json`)

`/estado/` y `/cambios/` salen de `data/cambios.json`; `build.mjs` los genera al publicar (sin JavaScript en la página).
Para publicar un aviso o una incidencia basta editar ese archivo y desplegar. El build falla (y Render mantiene la
versión anterior) si el archivo no es válido. Reglas que valida `cambios.mjs`: texto llano sin HTML; nada de IP,
URL, versiones ni nombres de proveedores o componentes; ni porcentajes ni promesas de disponibilidad; un cambio
`aviso` lleva `fechaPrevista` al menos 7 días después de `publicado`; con estado distinto de `ok` el `mensaje` es obligatorio.
Mientras no exista la comprobación externa (Dora) el nivel de estado se cambia a mano; poner `actualizado` al día. Las
incidencias de seguridad que afecten a datos siguen el protocolo de brechas (Lex Psi) y no se publican aquí.

## Configuración (`public/js/config.js`)

| Constante | Valor actual | Notas |
|---|---|---|
| `FEATURES.ownWaitlistForm` | `true` | Formulario propio de la lista de espera (sección `#apuntate`), enviado con `fetch` a `WAITLIST_API_URL`. Todos los botones "Apúntate" llevan a esa sección (`href="#apuntate"` en el HTML) y ponen el foco en el primer campo. **Apagado = red de seguridad**: la sección desaparece, los botones vuelven a `FORM_URL` (Google Forms, pestaña nueva) y los enlaces de privacidad a `FORM_PRIVACY_URL_FALLBACK` (v1). Si se apaga, cambiar también a mano el enlace de privacidad dentro del Google Form a `/privacidad-lista-espera/v1/` |
| (red de seguridad) | — | **Si se apaga `FEATURES.ownWaitlistForm`, en el mismo despliegue** hay que restaurar la mención a Google Forms en el apartado 5 de `/aviso-legal/` y el texto anterior del apartado 2 de `/privacidad/` (auditoría de Lex Psi, 12/10): si no, los dos textos dirían algo falso |
| `WAITLIST_API_URL` | `https://asepsico-api.onrender.com/api/v1` | API de la lista de espera. Único sitio con la URL. Si cambia el host: CSP (`connect-src`) y `CONNECT_ORIGINS` de `scripts/check-landing.mjs` |
| `WAITLIST_POLICY_VERSION` | `lista-espera-v3` | Se envía en `privacyPolicyVersion`. Tiene que coincidir con la versión visible en `/privacidad-lista-espera/` y estar entre las que acepta la API (`ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS`: v2 y v3 durante la transición). Al cambiarla, **desplegar primero la API y después la landing**; si no, el formulario devuelve 400 |
| `FORM_URL` | formulario de Google Forms de la lista de espera | Solo se usa con `FEATURES.ownWaitlistForm: false` (sin JavaScript, los botones van a `#apuntate`, que muestra un aviso y el email de contacto) |
| `FORM_PRIVACY_URL` | `/privacidad-lista-espera/` | Política de la lista de espera v3 (Lex Psi). Enlazada en el formulario, la FAQ 5, la llamada final y el pie, con `href` estático |
| `FORM_PRIVACY_URL_FALLBACK` | `/privacidad-lista-espera/v1/` | Política v1 (Google Forms, texto del Jefe del 29/09). Solo se enlaza con el formulario propio apagado. `noindex` y fuera del sitemap |
| `CONTACT_EMAIL` | `asepsico1@gmail.com` | También está escrito en los `mailto:` de las páginas (respaldo sin JavaScript) |
| `POPUP_TITLE` | "Sé de los primeros en probar AsePsico" | Título del aviso al entrar. Mientras esté vacío, el aviso no se muestra aunque `FEATURES.leadPopup` esté encendido |
| `PRICING_TEXT` | vacío | Texto del desplegable "Precios" (sin cifras). Solo se ve con `FEATURES.pricingDetails: true` y texto no vacío |
| `FEATURES.pricingDetails` | `false` | Desplegable "Precios" de la tarjeta del piloto. Apagado por decisión del Jefe: la web no habla de precios |
| `FEATURES.calculadora` | `false` | Calculadora "¿Cuánto tiempo te lleva lo que no sale en la agenda?". Pendiente de decisión del Jefe. Vive en un `<template>` y no se pinta si está apagada. Calcula en el navegador: no envía ni guarda nada |
| `FEATURES.faqPacientes` | `true` | Pregunta "Soy paciente, ¿puedo apuntarme?" con el 024 y el 112. Verificar el 024 la víspera de cada publicación |
| `FEATURES.instagram` | `false` | Enlace a @asepsico en el pie. Apagado hasta corregir la bio. Al encenderlo, añadir `"sameAs": ["https://www.instagram.com/asepsico/"]` al `Organization` del JSON-LD |
| `FEATURES.leadPopup` | `true` | Aviso "Sé de los primeros en probar AsePsico". Sale una vez por visita **solo al pasar el 50 % del scroll** (sin temporizador, para no contar como intersticial intrusivo en móvil). No es modal: no roba el foco ni bloquea la página. En escritorio es una tarjeta abajo a la derecha; en móvil, una barra pequeña pegada abajo (título, "Apuntarme" y cerrar). Se cierra con la X, "Ahora no" o Esc. No recoge datos ni guarda nada en el navegador |
| `FEATURES.savingsCalculator` | `false` | "Lo que te cuesta hoy" (decisión del Jefe, 07/10): horas a la semana por tarea (lista `SAVINGS.TASKS`), total a la semana y al mes (× 46/12, hacia abajo a la media hora), euros a la semana y al mes solo si se escribe el valor de la hora, y reparto en %. **No dice cuánto ahorra AsePsico**, no publica precios ni resta el coste de la herramienta. Vive en `<template id="tpl-ahorro">` y calcula en el navegador. La enciende el Jefe tras Lex Psi y Clio |
| `SAVINGS.TASKS` | 4 tareas (agrupadas por el Jefe, v4) | Lista ordenada de tareas de "Lo que te cuesta hoy" (`id`, `label`, `help`, `placeholder`). Cambiar una tarea es editar esta lista; los campos, el gráfico (hasta 9 colores en el CSS) y la leyenda se generan solos. Los campos empiezan vacíos: el placeholder es un ejemplo en gris que **no cuenta** y el resultado inicial es 0 h. Sin fila "Otra tarea" |

Bloques que **no deben existir** en `public/` hasta que se aprueben: la calculadora (guardada en
`borradores/calculadora.html`; `FEATURES.calculadora` no hace nada sin pegar antes ese bloque) y
"Experiencias del piloto" (solo con testimonios reales y consentimiento escrito; sin `Review` ni
`aggregateRating` en el JSON-LD).

## Probar el formulario en local (sin tocar producción)

Nunca enviar altas de prueba a la API de producción. Con la API de desarrollo:

```bash
docker compose up -d postgres redis minio
WAITLIST_ALLOWED_ORIGINS=http://localhost:8080 npm run dev:api   # (más el resto del .env de desarrollo)
```

Servir una **copia** de `public/` con `WAITLIST_API_URL: 'http://localhost:<puerto-api>/api/v1'` en su
`js/config.js` (el código admite `http://` solo para `localhost`/`127.0.0.1`), sin cambiar el
`config.js` del repositorio. Comprobar: token al enfocar, espera de 3 s, `202` → mensaje genérico (también
con un email repetido), `429` tras 5 envíos, error de red con la API parada, teclado y lector de pantalla.

## Previsualizar en local

Cualquier servidor estático sirviendo `public/` en la raíz (las rutas son absolutas, `/css/...`,
así que abrir el HTML con doble clic no carga los estilos):

```bash
python3 -m http.server 8080 --directory apps/landing/public
# y abrir http://localhost:8080/
```

Comprobar: escritorio (>= 960 px) y móvil (375 px). En escritorio, la sección "Seguimiento entre
sesiones" fija la pantalla (sticky), la abre en capas y la recompone paso a paso; en móvil, sin
JavaScript o con "Reducir movimiento" se ve como una pila estática de texto + pantalla, sin
animaciones. Revisar también el acordeón con teclado (Tab, Enter, Espacio), la estimación de tiempo
(`FEATURES.savingsCalculator`: campos vacíos, decimales con coma, sin peticiones de red al escribir) y que en la pestaña
Red no aparece ningún dominio externo.

## Desplegar en Render (Static Site)

New → Static Site → este repositorio, rama `main`:

| Campo | Valor |
|---|---|
| Root Directory | `apps/landing` |
| Build Command | `node build.mjs` |
| Publish Directory | `dist` |
| Environment | `LEGAL_TITULAR_NIF` y `LEGAL_TITULAR_DOMICILIO` (ver "Datos del titular") |
| Build Filters → Included Paths | `apps/landing/**` |
| Custom Domain | `asepsico.es` (y `www.asepsico.es` redirigiendo a la raíz) |

Cabeceras (Settings → Headers, ruta `/*`):

```
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https://asepsico-api.onrender.com; frame-ancestors 'none'; base-uri 'self'; form-action 'none'; object-src 'none'
```

`connect-src` incluye la API de la lista de espera (único cambio respecto a la versión anterior, para
el formulario propio). `form-action 'none'` se mantiene: el formulario se envía con `fetch`. Si la
API cambia de host, cambiar aquí, en `WAITLIST_API_URL` y en `CONNECT_ORIGINS` de
`scripts/check-landing.mjs` (que comprueba esta línea). La API, por su parte, solo acepta el origen
`https://asepsico.es` (y `www`) en `WAITLIST_ALLOWED_ORIGINS`.

Tras desplegar, comprobar que no hay cookies (`curl -sI https://asepsico.es` sin `Set-Cookie`, y la
pestaña Almacenamiento del navegador vacía): la FAQ 5 y la política dicen "no usa cookies".

Comprobaciones para Dora tras el primer despliegue (auditoría SEO de Mou, C4 y C7):

- `http://asepsico.es/` y `https://www.asepsico.es/` redirigen (301/308) a `https://asepsico.es/`.
- `/aviso-legal` sin barra: 301 a `/aviso-legal/` o 200 con el mismo contenido.
- `/no-existe/` devuelve **404 real** con la página propia `public/404.html` (`noindex`). Render
  Static Site sirve `/404.html` sola para las rutas que no existen y no casan con ninguna regla de
  *redirect/rewrite*: **no hay que añadir ninguna regla**, pero tampoco debe existir un *rewrite*
  `/*` → `/index.html` (taparía la 404). Comprobar: `curl -sI https://asepsico.es/no-existe/` da 404
  y el cuerpo es la página "No encontramos esta página".
- `Cache-Control`: `/fonts/*` un año `immutable`, `/img/*` 30 días, `/css/*` y `/js/*` una hora.
- La CSP servida lleva `connect-src 'self' https://asepsico-api.onrender.com` (`curl -sI https://asepsico.es | grep -i content-security`)
  y, en el navegador, el formulario `#apuntate` pide `GET .../public/waitlist/form-token` al enfocarlo sin
  errores de CSP en la consola. **No enviar altas de prueba a producción.**
- Ninguna respuesta con `Set-Cookie`.

## Sitemap

La home, `/privacidad/` y `/privacidad-lista-espera/` (las tres sin `noindex`; `/privacidad-lista-espera/v1/` y `/v2/` llevan `noindex` y quedan fuera), con `lastmod`
(cambiarlo solo cuando cambie el contenido). Nunca una URL con `noindex` (p. ej. `404.html`), oculta o
que redirija. `/aviso-legal/` queda fuera hasta que Lex Psi decida si lleva `noindex` (domicilio).

## Datos del titular (NIF y domicilio)

El repositorio es público (decisión del Jefe, 09/10): el NIF y el domicilio **no se escriben en el
código**. `public/aviso-legal/index.html` lleva `[[NIF]]` y `[[DOMICILIO]]`, y
`public/privacidad/index.html` lleva `[[DOMICILIO]]`. Al publicar, `build.mjs` los sustituye con las
variables de entorno del Static Site (Render → Static Site → **Environment**; nunca en el repo ni en
un `render.yaml`):

| Variable | Formato (igual que la API, `apps/api/src/legal/legal-documents.ts`) |
|---|---|
| `LEGAL_TITULAR_NIF` | DNI (8 cifras + letra) o NIE (X/Y/Z + 7 cifras + letra) con letra de control válida |
| `LEGAL_TITULAR_DOMICILIO` | una línea postal, 10–200 caracteres: letras, cifras y `.,ºª°'’/()-` |

- **Falla cerrado:** si falta una variable, tiene un formato no válido o queda algún marcador en la
  salida, el build termina con error y Render **mantiene la versión anterior** publicada.
- **No escribe los valores en el log de build**: solo cuántos marcadores ha sustituido.
- El HTML resultante no añade scripts ni estilos: la CSP no cambia.
- Probar en local (datos ficticios): `LEGAL_TITULAR_NIF=00000000T LEGAL_TITULAR_DOMICILIO="Calle
  Ficticia 1, 00000 Ninguna" node apps/landing/build.mjs` y servir `apps/landing/dist`.
- Los valores que ya estuvieran en el historial de git no se reescriben.

## Pendiente antes de publicar

- Quitar el `noindex` de `/aviso-legal/` y `/privacidad/` si lo llevan y añadirlas entonces al sitemap (decisión de Lex Psi).

- Confirmar el DPA de Render con cláusulas contractuales tipo (condición de Argos para el apartado 4
  de la privacidad).
- Verificar el 024 la víspera de publicar.
- Capturas reales C1–C6 con datos ficticios (opcional; los mockups actuales sirven mientras tanto).
