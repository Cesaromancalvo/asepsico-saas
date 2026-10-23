#!/usr/bin/env node
/**
 * Prueba "Estado y cambios" de la landing (apps/landing/cambios.mjs + data/cambios.json):
 *  1. el archivo real es válido;
 *  2. la validación rechaza: aviso con menos de 7 días, HTML, IP/URL/versión/proveedor, porcentajes
 *     y promesas de disponibilidad, fechas imposibles, estado no ok sin mensaje;
 *  3. el render escapa el texto y muestra "Aviso previo" / "Ya disponible";
 *  4. las dos páginas fuente no llevan comentarios HTML y llevan su marcador.
 * Uso: node scripts/check-landing-cambios.mjs (lo llama npm run test:landing). Sin dependencias.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCambios, renderEstado, validar } from '../apps/landing/cambios.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)), 'apps/landing');
const fallos = [];
const espera = (cond, msg) => {
  if (!cond) fallos.push(msg);
};

const real = JSON.parse(readFileSync(join(root, 'data/cambios.json'), 'utf8'));
espera(validar(real).length === 0, `data/cambios.json no es válido: ${validar(real).join('; ')}`);

const base = () => ({
  estado: { nivel: 'ok', actualizado: '2026-10-18', mensaje: '' },
  incidencias: [{ fecha: '2026-10-10', duracion: '20 minutos', descripcion: 'No se podía iniciar sesión.' }],
  cambios: [
    {
      id: 'agenda-nueva-vista',
      publicado: '2026-10-18',
      fechaPrevista: '2026-10-25',
      tipo: 'aviso',
      titulo: 'Nueva vista de la agenda',
      queCambia: 'La agenda semanal cambia de aspecto.',
      paraQuien: 'Todo el equipo.',
      queHacer: 'Nada: se aplica solo.',
    },
    {
      id: 'mejora-listas',
      publicado: '2026-10-12',
      tipo: 'disponible',
      titulo: 'Listas más rápidas',
      queCambia: 'Las listas cargan antes.',
      paraQuien: 'Todos.',
      queHacer: 'Nada.',
    },
  ],
});
espera(validar(base()).length === 0, `el ejemplo válido falla: ${validar(base()).join('; ')}`);

const casos = [
  ['aviso con 6 días', (d) => { d.cambios[0].fechaPrevista = '2026-10-24'; }],
  ['aviso sin fecha prevista', (d) => { delete d.cambios[0].fechaPrevista; }],
  ['HTML en un texto', (d) => { d.cambios[0].queCambia = 'Hola <b>x</b>'; }],
  ['dirección IP', (d) => { d.incidencias[0].descripcion = 'Caída del servidor 10.0.0.12'; }],
  ['URL', (d) => { d.incidencias[0].descripcion = 'Ver https://ejemplo.test/x'; }],
  ['versión', (d) => { d.cambios[1].queCambia = 'Actualizamos a la versión 4.2.1.'; }],
  ['proveedor', (d) => { d.incidencias[0].descripcion = 'Caída de Render'; }],
  ['porcentaje', (d) => { d.incidencias[0].descripcion = 'Disponibilidad del 99,9 %'; }],
  ['promesa', (d) => { d.cambios[1].queHacer = 'Garantizamos que no se caerá.'; }],
  ['fecha imposible', (d) => { d.estado.actualizado = '2026-02-31'; }],
  ['estado con problemas sin mensaje', (d) => { d.estado.nivel = 'degradado'; }],
  ['nivel desconocido', (d) => { d.estado.nivel = 'genial'; }],
  ['id repetido', (d) => { d.cambios[1].id = d.cambios[0].id; }],
];
for (const [nombre, mutar] of casos) {
  const d = base();
  mutar(d);
  espera(validar(d).length > 0, `la validación debía rechazar: ${nombre}`);
}

const peligro = base();
peligro.cambios[1].titulo = 'A & B "c"';
const html = `${renderEstado(peligro)}${renderCambios(peligro)}`;
espera(html.includes('Aviso previo') && html.includes('Ya disponible'), 'faltan las etiquetas de los cambios');
espera(html.includes('A &amp; B &quot;c&quot;'), 'el render no escapa el texto');
espera(html.includes('Sin incidencias conocidas') && html.includes('25 de octubre de 2026'), 'faltan el estado o la fecha en español');
espera(renderCambios({ cambios: [] }).includes('Todavía no hay cambios'), 'falta el estado vacío');

for (const pagina of ['estado/index.html', 'cambios/index.html']) {
  const src = readFileSync(join(root, 'public', pagina), 'utf8');
  espera(!/<!--/.test(src), `${pagina}: no debe llevar comentarios HTML`);
  espera(/\[\[(ESTADO|CAMBIOS)\]\]/.test(src), `${pagina}: falta el marcador`);
}

if (fallos.length) {
  for (const f of fallos) console.error(`ERROR   ${f}`);
  console.error(`\ncheck-landing-cambios: ${fallos.length} problema(s).`);
  process.exit(1);
}
console.log('check-landing-cambios: OK');
