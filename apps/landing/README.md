# Landing pública de AsePsico (asepsico.es)

Web estática de una sola página: HTML, CSS y un poco de JavaScript sin dependencias.
**No tiene `package.json`** a propósito: npm workspaces no la recoge, así que ni `npm ci`, ni el
typecheck ni el build del monorepo la tocan, y ella no depende de la app.

## Estructura

```
apps/landing/
  public/                  <- directorio que se publica
    index.html             <- la landing
    aviso-legal/index.html <- estructura con huecos TODO (lo redactan y revisan Pax y Argos)
    privacidad/index.html  <- idem
    css/styles.css
    js/config.js           <- enlaces e interruptores (lo único que hay que tocar)
    js/main.js             <- acordeón, animación del hero, interruptores, calculadora
    fonts/                 <- Poppins autoalojada (woff2, subconjunto latino) + OFL.txt
    img/                   <- logo y og-image.png (1200x630)
    favicon.ico, favicon.png, apple-touch-icon.png, robots.txt, sitemap.xml
```

## Reglas de la landing

- **Ninguna petición a terceros**: fuentes, imágenes, iconos y scripts se sirven desde la propia web.
  Nada de `<iframe>`, Google Fonts, CDN, vídeos ni píxeles. El formulario de la lista de espera es
  un **enlace** normal (`target="_blank" rel="noopener noreferrer"`). La única excepción prevista es
  el script de Plausible, hoy comentado.
- **Sin scripts ni estilos en línea**, para poder servirla con una CSP estricta (ver abajo).
- **Capturas**: de momento son mockups dibujados en HTML con datos ficticios y la etiqueta
  "Diseño / prototipo · datos ficticios" siempre visible. Cuando haya capturas reales (C1–C6), deben
  conservar esa etiqueta.
- Comprobación rápida de dominios externos (debe salir solo plausible.io comentado, el formulario, Instagram
  y las URL canónicas de asepsico.es):

  ```bash
  grep -rnoE 'https?://[^"'"'"' )<]+' apps/landing/public | sort -u
  ```

## Configuración (`public/js/config.js`)

| Constante | Valor actual | Notas |
|---|---|---|
| `FORM_URL` | formulario de Google Forms de la lista de espera | Si cambia, actualizar también los `href` de `index.html` (respaldo sin JavaScript) |
| `CONTACT_EMAIL` | vacío (TODO) | Mientras esté vacío no se muestra "Contacto" en el pie |
| `FEATURES.calculadora` | `false` | Calculadora "¿Cuánto tiempo te lleva lo que no sale en la agenda?". Pendiente de decisión del Jefe tras Argos y Pax. Vive en un `<template>` y no se pinta si está apagada. Calcula en el navegador: no envía ni guarda nada ni lo manda a la analítica |
| `FEATURES.faqPacientes` | `true` | Pregunta "Soy paciente, ¿puedo apuntarme?" con el 024 y el 112. Pendiente de confirmación; verificar el 024 antes de publicar |

## Analítica (Plausible, pendiente)

El snippet está **comentado** en el `<head>` de `index.html` con un TODO. Para activarlo:

1. Crear el sitio `asepsico.es` en Plausible y el objetivo de evento personalizado **"Lista espera"**
   (el nombre exacto; no es retroactivo). Opcional: la propiedad `seccion` para ver desde qué bloque
   se pulsa (barra-superior, hero, calculadora, piloto, final).
2. Descomentar el `<script defer ... script.tagged-events.js>`.
3. Añadir `https://plausible.io` a `script-src` y `connect-src` en la CSP de Render.

Todos los botones de la lista de espera llevan la clase `plausible-event-name=Lista+espera`: es un
único evento. Las UTM (`?utm_source=instagram&utm_medium=social&utm_campaign=lista-espera`) las lee
Plausible de la URL; la landing no redirige ni reescribe la URL, así que se conservan. Nunca poner
nombres ni emails en las UTM.

## Previsualizar en local

Cualquier servidor estático sirviendo `public/` en la raíz (las rutas son absolutas, `/css/...`,
así que abrir el HTML con doble clic no carga los estilos):

```bash
python3 -m http.server 8080 --directory apps/landing/public
# y abrir http://localhost:8080/
```

Alternativa con Node: `npx serve apps/landing/public`.

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

Cuando se active Plausible: `script-src 'self' https://plausible.io; connect-src 'self' https://plausible.io`.

## Pendiente antes de publicar

- Textos: validación de Clio (frases nuevas) y Argos (privacidad, calculadora y pregunta de pacientes).
- `CONTACT_EMAIL` y datos del aviso legal y la privacidad (NIF, domicilio, textos): Jefe, Pax y Argos.
  Quitar el `noindex` de esas dos páginas cuando estén aprobadas.
- Plausible: cuenta, objetivo "Lista espera" y descomentar el snippet.
- Capturas reales C1–C6 con datos ficticios (opcional; los mockups actuales sirven mientras tanto).
