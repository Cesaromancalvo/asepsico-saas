# Landing pública de AsePsico (asepsico.es)

Web estática de una sola página: HTML, CSS y un poco de JavaScript sin dependencias.
**No tiene `package.json`** a propósito: npm workspaces no la recoge, así que ni `npm ci`, ni el
typecheck ni el build del monorepo la tocan, y ella no depende de la app.

## Estructura

```
apps/landing/
  borradores/              <- bloques NO publicados (p. ej. la calculadora); fuera de public/
  public/                  <- directorio que se publica
    index.html             <- la landing
    aviso-legal/index.html <- aviso legal (texto final de Argos)
    privacidad/index.html  <- política de privacidad y cookies (versión sin analítica)
    css/styles.css
    js/config.js           <- enlaces, datos legales e interruptores (lo único que hay que tocar)
    js/main.js             <- acordeón, animación del hero, interruptores, calculadora
    fonts/                 <- Poppins autoalojada (woff2, subconjunto latino) + OFL.txt
    img/                   <- logo y og-image.png (1200x630)
    favicon.ico, favicon.png, apple-touch-icon.png, robots.txt, sitemap.xml
```

## Reglas de la landing

- **Ninguna petición a terceros**: fuentes, imágenes, iconos y scripts se sirven desde la propia web.
  Nada de `<iframe>`, Google Fonts, CDN, vídeos ni píxeles. El formulario de la lista de espera y
  Instagram son **enlaces** normales (`target="_blank" rel="noopener noreferrer"`).
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
comentarios. Avisa, sin fallar, si quedan los marcadores `[[NIF]]` o `[[DOMICILIO]]`.
Excepción: los bloques `<script type="application/ld+json">` (datos estructurados) se permiten si
son JSON válido, no llevan `src` y solo contienen URLs de la propia web o el identificador
`https://schema.org` (que no se descarga). Fuera del JSON-LD, `schema.org` no está permitido.
No hace falta tocar la CSP: un bloque de datos no se ejecuta.

```bash
npm run test:landing
```

Si se añade un dominio nuevo (por ejemplo, el de la política del formulario), hay que añadirlo a
`ALLOWED_HOSTS` en ese script.

## Configuración (`public/js/config.js`)

| Constante | Valor actual | Notas |
|---|---|---|
| `FORM_URL` | formulario de Google Forms de la lista de espera | Si cambia, actualizar también los `href` de `index.html` (respaldo sin JavaScript) |
| `FORM_PRIVACY_URL` | `/privacidad-lista-espera/` | Política de la lista de espera (página propia, texto del Jefe del 29/09). Enlazada en la FAQ 5, la llamada final y el pie, con `href` estático |
| `CONTACT_EMAIL` | `asepsico1@gmail.com` | También está escrito en los `mailto:` de las páginas (respaldo sin JavaScript) |
| `POPUP_TITLE` | vacío (TODO) | Título del aviso al entrar. Mientras esté vacío, el aviso no se muestra aunque `FEATURES.leadPopup` esté encendido |
| `PRICING_TEXT` | vacío (TODO) | Texto del desplegable "Precios" (sin cifras). Solo se ve con `FEATURES.pricingDetails: true` y texto no vacío |
| `FEATURES.pricingDetails` | `false` | Desplegable "Precios" de la tarjeta del piloto |
| `FEATURES.calculadora` | `false` | Calculadora "¿Cuánto tiempo te lleva lo que no sale en la agenda?". Pendiente de decisión del Jefe. Vive en un `<template>` y no se pinta si está apagada. Calcula en el navegador: no envía ni guarda nada |
| `FEATURES.faqPacientes` | `true` | Pregunta "Soy paciente, ¿puedo apuntarme?" con el 024 y el 112. Verificar el 024 la víspera de cada publicación |
| `FEATURES.instagram` | `false` | Enlace a @asepsico en el pie. Apagado hasta corregir la bio. Al encenderlo, añadir `"sameAs": ["https://www.instagram.com/asepsico/"]` al `Organization` del JSON-LD |
| `FEATURES.leadPopup` | `true` | Aviso "¿Te avisamos cuando abramos el piloto?" a los 8 s o al 50 % del scroll. Solo enlaza al formulario: no recoge datos ni guarda nada en el navegador (sin cookies ni localStorage), así que puede volver a salir al recargar. Se cierra con la X, "Ahora no", Esc o clic fuera; foco atrapado y devuelto al cerrar |

Bloques que **no deben existir** en `public/` hasta que se aprueben: la calculadora (guardada en
`borradores/calculadora.html`; `FEATURES.calculadora` no hace nada sin pegar antes ese bloque) y
"Experiencias del piloto" (solo con testimonios reales y consentimiento escrito; sin `Review` ni
`aggregateRating` en el JSON-LD).

## Previsualizar en local

Cualquier servidor estático sirviendo `public/` en la raíz (las rutas son absolutas, `/css/...`,
así que abrir el HTML con doble clic no carga los estilos):

```bash
python3 -m http.server 8080 --directory apps/landing/public
# y abrir http://localhost:8080/
```

Comprobar: escritorio y móvil (375 px), la animación del hero con su botón de pausa, que con
"Reducir movimiento" activado en el sistema se ve la ficha del paciente estática, el acordeón con
teclado (Tab, Enter, Espacio) y que en la pestaña Red no aparece ningún dominio externo.

## Desplegar en Render (Static Site)

New → Static Site → este repositorio, rama `main`:

| Campo | Valor |
|---|---|
| Root Directory | `apps/landing` |
| Build Command | `echo ok` (no hay build) |
| Publish Directory | `public` |
| Build Filters → Included Paths | `apps/landing/**` |
| Custom Domain | `asepsico.es` (y `www.asepsico.es` redirigiendo a la raíz) |

Cabeceras (Settings → Headers, ruta `/*`):

```
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'; object-src 'none'
```

Tras desplegar, comprobar que no hay cookies (`curl -sI https://asepsico.es` sin `Set-Cookie`, y la
pestaña Almacenamiento del navegador vacía): la FAQ 5 y la política dicen "no usa cookies".

Comprobaciones para Dora tras el primer despliegue (auditoría SEO de Mou, C4 y C7):

- `http://asepsico.es/` y `https://www.asepsico.es/` redirigen (301/308) a `https://asepsico.es/`.
- `/aviso-legal` sin barra: 301 a `/aviso-legal/` o 200 con el mismo contenido.
- `/no-existe/` devuelve **404 real** (sin reglas de *rewrite* `/*` → `/index.html`). Valorar una
  `404.html` con `noindex` si Render la sirve.
- `Cache-Control`: `/fonts/*` un año `immutable`, `/img/*` 30 días, `/css/*` y `/js/*` una hora.
- Ninguna respuesta con `Set-Cookie`.

## Sitemap

Solo la home, con `lastmod` (cambiarlo solo cuando cambie el contenido). Las páginas legales entran
cuando se quite su `noindex`; nunca una URL con `noindex`, oculta o que redirija.

## Pendiente antes de publicar

- NIF: sustituir `[[NIF]]` en `public/aviso-legal/index.html` (único sitio; el check de CI avisa mientras siga) y quitar el `noindex` de `/aviso-legal/` y `/privacidad/`; añadirlas entonces al sitemap.
- `POPUP_TITLE` y, si se quiere el desplegable, `PRICING_TEXT` + `FEATURES.pricingDetails`.
- Confirmar el DPA de Render con cláusulas contractuales tipo (condición de Argos para el apartado 4
  de la privacidad).
- Verificar el 024 la víspera de publicar.
- Capturas reales C1–C6 con datos ficticios (opcional; los mockups actuales sirven mientras tanto).
