/**
 * Estado y cambios de AsePsico: valida data/cambios.json y genera el HTML de /estado/ y /cambios/.
 * Lo usa build.mjs al publicar y scripts/check-landing-cambios.mjs en el CI. Sin dependencias.
 *
 * Reglas (docs/producto/mejoras-salida-y-confianza.md, historia C):
 *  - texto llano, sin datos de pacientes ni de clientes, sin datos de infraestructura
 *    (direcciones IP, URL, versiones, proveedores);
 *  - un "aviso" (cambio que modifica un flujo diario) se publica con al menos 7 días de antelación
 *    a la fecha prevista;
 *  - sin promesas de disponibilidad (la validación rechaza porcentajes y "SLA"/"garantizamos").
 */

export const NIVELES = {
  ok: { etiqueta: 'Sin incidencias conocidas', clase: 'ok' },
  degradado: { etiqueta: 'Funcionamos con problemas', clase: 'warn' },
  interrumpido: { etiqueta: 'Servicio interrumpido', clase: 'down' },
};
export const MIN_DIAS_AVISO = 7;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const PROHIBIDO = [
  [/\b\d{1,3}(\.\d{1,3}){3}\b/, 'una dirección IP'],
  [/https?:\/\//i, 'una URL'],
  [/\bv?\d+\.\d+\.\d+\b/i, 'un número de versión'],
  [/\b(render|postgres(ql)?|redis|minio|docker|prisma|nestjs|next\.?js|aws|vercel|cloudflare|hostinger)\b/i, 'un nombre de proveedor o componente interno'],
  [/\d+([.,]\d+)?\s?%/, 'un porcentaje (no se prometen cifras de disponibilidad)'],
  [/\b(sla|garantizamos|garantizado|99)\b/i, 'una promesa de disponibilidad'],
];

function fecha(valor) {
  const m = ISO.exec(valor ?? '');
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null;
}

export function fechaLarga(valor) {
  const d = fecha(valor);
  return d ? `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}` : '';
}

/** Devuelve la lista de problemas (vacía si el archivo es válido). */
export function validar(datos) {
  const errores = [];
  const texto = (ruta, v, max, { obligatorio = true } = {}) => {
    if (v === undefined || v === '' || v === null) {
      if (obligatorio) errores.push(`${ruta}: obligatorio`);
      return;
    }
    if (typeof v !== 'string') return errores.push(`${ruta}: debe ser texto`);
    if (v.length > max) errores.push(`${ruta}: máximo ${max} caracteres`);
    if (/[<>]/.test(v)) errores.push(`${ruta}: no puede llevar HTML`);
    for (const [re, que] of PROHIBIDO) if (re.test(v)) errores.push(`${ruta}: contiene ${que}`);
  };
  const dia = (ruta, v) => {
    if (!fecha(v)) errores.push(`${ruta}: fecha no válida (AAAA-MM-DD)`);
  };

  if (!datos || typeof datos !== 'object') return ['el archivo debe ser un objeto JSON'];
  const e = datos.estado;
  if (!e || !NIVELES[e.nivel]) errores.push(`estado.nivel: uno de ${Object.keys(NIVELES).join(', ')}`);
  dia('estado.actualizado', e?.actualizado);
  texto('estado.mensaje', e?.mensaje, 300, { obligatorio: e?.nivel !== 'ok' });

  if (!Array.isArray(datos.incidencias)) errores.push('incidencias: debe ser una lista');
  for (const [i, inc] of (datos.incidencias ?? []).entries()) {
    const r = `incidencias[${i}]`;
    dia(`${r}.fecha`, inc.fecha);
    texto(`${r}.duracion`, inc.duracion, 40);
    texto(`${r}.descripcion`, inc.descripcion, 300);
  }

  if (!Array.isArray(datos.cambios)) errores.push('cambios: debe ser una lista');
  const ids = new Set();
  for (const [i, c] of (datos.cambios ?? []).entries()) {
    const r = `cambios[${i}]`;
    if (!/^[a-z0-9-]{3,60}$/.test(c.id ?? '')) errores.push(`${r}.id: minúsculas, cifras y guiones`);
    else if (ids.has(c.id)) errores.push(`${r}.id: repetido`);
    else ids.add(c.id);
    dia(`${r}.publicado`, c.publicado);
    if (c.tipo !== 'aviso' && c.tipo !== 'disponible') errores.push(`${r}.tipo: "aviso" o "disponible"`);
    texto(`${r}.titulo`, c.titulo, 100);
    texto(`${r}.queCambia`, c.queCambia, 500);
    texto(`${r}.paraQuien`, c.paraQuien, 200);
    texto(`${r}.queHacer`, c.queHacer, 400);
    if (c.tipo === 'aviso') {
      dia(`${r}.fechaPrevista`, c.fechaPrevista);
      const p = fecha(c.publicado);
      const f = fecha(c.fechaPrevista);
      if (p && f && (f - p) / 86400000 < MIN_DIAS_AVISO) {
        errores.push(`${r}: un aviso se publica con al menos ${MIN_DIAS_AVISO} días de antelación a la fecha prevista`);
      }
    }
  }
  return errores;
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderEstado(datos) {
  const n = NIVELES[datos.estado.nivel];
  const incidencias = [...datos.incidencias].sort((a, b) => b.fecha.localeCompare(a.fecha));
  const lista = incidencias.length
    ? `<ul class="legal-list">${incidencias
        .map((i) => `<li><strong>${esc(fechaLarga(i.fecha))}</strong> · ${esc(i.duracion)}. ${esc(i.descripcion)}</li>`)
        .join('')}</ul>`
    : '<p>No hay incidencias publicadas.</p>';
  return `<section class="status status--${n.clase}" aria-labelledby="estado-actual">
        <h2 id="estado-actual" class="status__title">${esc(n.etiqueta)}</h2>
        ${datos.estado.mensaje ? `<p>${esc(datos.estado.mensaje)}</p>` : ''}
        <p class="small">Última actualización: ${esc(fechaLarga(datos.estado.actualizado))}</p>
      </section>
      <h2>Incidencias recientes</h2>
      ${lista}`;
}

function renderCambio(c) {
  const aviso = c.tipo === 'aviso';
  const etiqueta = aviso ? 'Aviso previo' : 'Ya disponible';
  const cuando = aviso ? `Fecha prevista: ${fechaLarga(c.fechaPrevista)}` : `Publicado el ${fechaLarga(c.publicado)}`;
  return `<article class="change" aria-labelledby="c-${esc(c.id)}">
        <p class="change__meta"><span class="tag tag--${aviso ? 'notice' : 'done'}">${etiqueta}</span> ${esc(cuando)}</p>
        <h3 id="c-${esc(c.id)}">${esc(c.titulo)}</h3>
        <dl>
          <dt>Qué cambia</dt><dd>${esc(c.queCambia)}</dd>
          <dt>Para quién</dt><dd>${esc(c.paraQuien)}</dd>
          <dt>Qué tienes que hacer</dt><dd>${esc(c.queHacer)}</dd>
        </dl>
      </article>`;
}

export function renderCambios(datos) {
  if (!datos.cambios.length) return '<p>Todavía no hay cambios publicados. Cuando haya uno, lo verás aquí.</p>';
  const orden = [...datos.cambios].sort((a, b) => b.publicado.localeCompare(a.publicado));
  return orden.map(renderCambio).join('\n      ');
}
