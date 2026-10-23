#!/usr/bin/env node
/**
 * Prueba el formulario de la lista de espera de la landing (bloque 8 de apps/landing/public/js/main.js)
 * con un DOM mínimo simulado y un fetch FALSO: nunca se hace ninguna petición de red real.
 *
 * Comprueba:
 *  1. al cargar se pide UN token (despierta la API de Render) sin ningún POST, sin referer ni cookies;
 *     varios focos no piden otro; si el de la carga falla, el foco lo vuelve a pedir;
 *  2. no se envía antes de minSeconds desde que se emitió el token;
 *  3. tras el 202: mensaje final visible, campos vacíos (form.reset) y token descartado;
 *  4. tras un 400 (y un 429) el token no se reenvía: el siguiente envío pide otro;
 *  5. WAITLIST_FORM_TOO_FAST reintenta una vez con el mismo token; WAITLIST_FORM_TOKEN_INVALID pide otro;
 *  6. todas las peticiones con credentials: 'omit' y sin tocar localStorage, sessionStorage ni cookies;
 *  7. mensajes: 429, fallo de red y validación sin red;
 *  8. "¿Qué usas hoy?": opciones, "Otra" con caja de máx. 100 caracteres, y sin campos commercialConsent*;
 *  9. versión de la política: config.js = página = contrato, aceptada por la API, y archivadas con noindex;
 * 10. arranque en frío (tiempos escalados): mensajes a los 6 s y a los 20 s, timeout a los 90 s sin
 *     reintento, sin doble envío mientras espera, un único reintento tras un fallo de red y el envío
 *     espera al token que se está pidiendo desde la carga.
 *
 * Uso: node scripts/check-landing-form.mjs   (lo llama npm run test:landing). Sin dependencias.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pub = join(repoRoot, 'apps/landing/public');
const configSrc = readFileSync(join(pub, 'js/config.js'), 'utf8');
const mainSrc = readFileSync(join(pub, 'js/main.js'), 'utf8');
const API = 'https://asepsico-api.onrender.com/api/v1';

const TOOL_OPTIONS = ['Doctoralia', 'Eholo', 'Excel / hojas de cálculo', 'Papel / agenda', 'Nada todavía', 'Otra'];
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- DOM mínimo: cada elemento responde a los selectores exactos que se le registran ---- */
class El {
  constructor(id, props = {}) {
    this.id = id || '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.textContent = '';
    this.className = '';
    this.attrs = {};
    this.listeners = {};
    this.sel = {};
    Object.assign(this, props);
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  }
  add(selector, el) { (this.sel[selector] ||= []).push(el); return el; }
  querySelector(s) { return (this.sel[s] || [])[0] || null; }
  querySelectorAll(s) { return this.sel[s] || []; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(type, extra = {}) {
    const ev = { type, defaultPrevented: false, button: 0, preventDefault() { this.defaultPrevented = true; }, ...extra };
    (this.listeners[type] || []).forEach((fn) => fn.call(this, ev));
    return ev;
  }
  focus() { doc.activeElement = this; }
  scrollIntoView() {}
  contains() { return false; }
  appendChild() {}
}

let doc;
function buildDom() {
  const byId = {};
  const reg = (el) => { if (el.id) byId[el.id] = el; return el; };
  doc = new El('document');
  doc.activeElement = null;
  doc.getElementById = (id) => byId[id] || null;
  doc.createElement = () => new El();
  doc.documentElement = new El('html');
  doc.body = new El('body');
  doc.readyState = 'complete';

  const section = reg(new El('apuntate'));
  doc.add('[data-feature]', section).attrs['data-feature'] = 'ownWaitlistForm';
  const form = section.add('[data-waitlist-form]', new El('form'));
  form.reset = () => {
    for (const el of Object.values(byId)) { if ('value' in el && el.isField) el.value = ''; if (el.isField) el.checked = false; }
  };
  form.requestSubmit = () => form.dispatch('submit');
  section.add('[data-waitlist-fields]', new El('fields', { disabled: true }));
  section.add('[data-waitlist-nojs]', new El('nojs'));
  const done = section.add('[data-wl-done]', new El('done', { hidden: true }));
  section.add('[data-wl-status]', new El('status'));
  section.add('[data-wl-submit]', new El('submit'));
  const countWrap = section.add('[data-wl-count-wrap]', new El('count-wrap'));

  const field = (id, extra = {}) => {
    const el = reg(new El(id, { isField: true, ...extra }));
    form.add(`#${id}`, el);
    return el;
  };
  field('wl-name').setAttribute('aria-describedby', 'wl-name-err');
  field('wl-email').setAttribute('aria-describedby', 'wl-email-err');
  field('wl-count').setAttribute('aria-describedby', 'wl-count-err');
  field('wl-tool-other').setAttribute('aria-describedby', 'wl-tool-other-help wl-tool-other-err');
  const toolOtherWrap = form.add('[data-wl-tool-other-wrap]', new El('tool-other-wrap', { hidden: true }));
  field('wl-source');
  field('wl-website');
  field('wl-privacy');
  const group = form.add('[data-wl-group="situation"]', new El('situation-group'));
  for (const v of ['SELF_EMPLOYED', 'PRACTICE', 'STUDENT', 'OTHER']) {
    form.add('input[name="situation"]', reg(new El(`sit-${v}`, { value: v, isField: true })));
  }
  for (const v of TOOL_OPTIONS) {
    form.add('input[name="currentTool"]', reg(new El(`tool-${v}`, { value: v, isField: true, radio: true })));
  }
  // Los radios conservan su value al hacer reset (como en el navegador): solo se desmarcan.
  const origReset = form.reset;
  form.reset = () => {
    origReset();
    for (const r of form.querySelectorAll('input[name="situation"]')) r.value = r.id.slice(4);
    for (const r of form.querySelectorAll('input[name="currentTool"]')) r.value = r.id.slice(5);
  };
  for (const id of ['wl-name-err', 'wl-email-err', 'wl-situation-err', 'wl-count-err', 'wl-tool-other-err', 'wl-privacy-err']) {
    reg(new El(id, { hidden: true }));
  }
  const cta = doc.add('a[data-cta]', new El('cta'));
  return { section, form, done, countWrap, toolOtherWrap, group, cta, status: section.querySelector('[data-wl-status]') };
}

/* ---- fetch falso: cola de respuestas por ruta y registro de llamadas ---- */
function makeFetch(preset = {}) {
  const calls = [];
  const queue = { token: [...(preset.token || [])], post: [...(preset.post || [])] };
  let n = 0;
  const fake = async (url, init = {}) => {
    const path = url.replace(API, '');
    const call = { path, init, at: Date.now(), body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (!url.startsWith(API)) throw new Error(`URL inesperada: ${url}`);
    const kind = path === '/public/waitlist/form-token' ? 'token' : path === '/public/waitlist' ? 'post' : null;
    let next = queue[kind].shift();
    if (!next && kind === 'token') next = { status: 200, body: { formToken: `tok-${++n}`, minSeconds: 0 } };
    if (!next) next = { status: 202, body: { status: 'accepted' } };
    if (next === 'network') throw new TypeError('Failed to fetch');
    // 'hang': no responde nunca; solo termina si se aborta (timeout). { delay }: responde tarde.
    if (next === 'hang' || next.delay) {
      await new Promise((res, rej) => {
        if (next.delay) setTimeout(res, next.delay);
        if (init.signal) init.signal.addEventListener('abort', () => rej(new Error('AbortError')));
      });
    }
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { fake, calls, queue };
}

// opts.token / opts.post: respuestas preparadas ANTES de cargar (el token se pide al cargar).
// opts.timeScale: divide los temporizadores de main.js (6 s, 20 s, 90 s…) para probarlos en ms.
function load(opts = {}) {
  const dom = buildDom();
  const net = makeFetch(opts);
  const scale = opts.timeScale || 1;
  const scaledTimeout = (fn, ms) => setTimeout(fn, (ms || 0) / scale);
  const storageHits = [];
  const trap = (name) => ({ get() { storageHits.push(name); return { getItem() {}, setItem() {} }; } });
  const win = {
    fetch: net.fake,
    setTimeout: scaledTimeout, clearTimeout, Promise, JSON, AbortController, console: { error: () => {}, log() {} },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    document: doc, innerHeight: 800, scrollY: 0,
  };
  Object.defineProperty(win, 'localStorage', trap('localStorage'));
  Object.defineProperty(win, 'sessionStorage', trap('sessionStorage'));
  Object.defineProperty(doc, 'cookie', { get() { storageHits.push('cookie'); return ''; }, set() { storageHits.push('cookie'); } });
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(configSrc, ctx);
  vm.runInContext(mainSrc, ctx);
  return { ...dom, net, storageHits };
}

function fill(t, opts = {}) {
  const f = t.form;
  f.querySelector('#wl-name').value = 'Persona Ficticia';
  f.querySelector('#wl-email').value = opts.email || 'ficticia@example.com';
  f.querySelectorAll('input[name="situation"]')[0].checked = true;
  f.querySelector('#wl-privacy').checked = true;
  if (opts.tool) {
    const r = f.querySelectorAll('input[name="currentTool"]').find((x) => x.value === opts.tool);
    r.checked = true;
    r.dispatch('change');
    if (opts.toolOther !== undefined) f.querySelector('#wl-tool-other').value = opts.toolOther;
  }
}
const tokenCalls = (t) => t.net.calls.filter((c) => c.path.endsWith('/form-token'));
const posts = (t) => t.net.calls.filter((c) => c.path === '/public/waitlist');
async function submitAndWait(t, ms = 500) { t.form.dispatch('submit'); await sleep(ms); }

/* ---- 1. Al cargar, un solo token (despierta la API); varios focos no piden otro ---- */
{
  const t = load();
  await sleep(20);
  check(t.net.calls.length === 1 && tokenCalls(t).length === 1, `1: al cargar se hicieron ${t.net.calls.length} peticiones (debe ser 1: el token)`);
  const c = tokenCalls(t)[0];
  if (c) {
    check(c.init.method === 'GET' && !c.init.body, '1: la petición de la carga no es un GET sin cuerpo');
    check(c.init.credentials === 'omit' && c.init.referrerPolicy === 'no-referrer', '1: la petición de la carga lleva cookies o referer');
  }
  check(t.section.querySelector('[data-waitlist-fields]').disabled === false, '1: el formulario no se activó');
  t.form.dispatch('focusin'); t.form.dispatch('focusin'); t.form.dispatch('focusin');
  await sleep(20);
  check(tokenCalls(t).length === 1, `1: tres focos pidieron ${tokenCalls(t).length} tokens (debe ser 1)`);
  t.form.dispatch('focusin');
  await sleep(20);
  check(tokenCalls(t).length === 1, '1: un foco con token vigente volvió a pedirlo');
}
{
  const t = load({ token: ['network'] });
  await sleep(20);
  t.form.dispatch('focusin');
  await sleep(20);
  check(tokenCalls(t).length === 2, `1: si falla el token de la carga, el foco debe pedirlo otra vez (hubo ${tokenCalls(t).length})`);
}

/* ---- 2 y 3. Espera minSeconds; 202 → mensaje, campos vacíos, token descartado ---- */
{
  const t = load({ token: [{ status: 200, body: { formToken: 'tok-espera', minSeconds: 1 } }] });
  t.form.dispatch('focusin');
  await sleep(10);
  const tokenAt = tokenCalls(t)[0].at;
  fill(t, { tool: 'Otra', toolOther: '  Un   programa propio ' });
  check(t.toolOtherWrap.hidden === false, '8: al marcar "Otra" no aparece la caja de texto');
  await submitAndWait(t, 1500);
  const p = posts(t);
  check(p.length === 1, `2: se esperaban 1 envío y hubo ${p.length}`);
  if (p[0]) {
    check(p[0].at - tokenAt >= 1000, `2: se envió ${p[0].at - tokenAt} ms después del token (mínimo 1000)`);
    check(p[0].body.formToken === 'tok-espera', '2: no se envió el token recibido');
    check(p[0].body.privacyPolicyVersion === 'lista-espera-v4', '2: privacyPolicyVersion distinto de lista-espera-v4');
    check(!Object.keys(p[0].body).some((k) => k.startsWith('commercialConsent')), '2: se envió un campo commercialConsent* (la casilla de novedades ya no existe)');
    check(p[0].body.tools === 'Otra: Un programa propio', `8: "Otra" con texto se envió como "${p[0].body.tools}"`);
    check(p[0].init.headers['Content-Type'] === 'application/json', '2: falta Content-Type JSON');
  }
  check(t.done.hidden === false, '3: tras el 202 no se muestra el mensaje final');
  check(t.form.hidden === true, '3: tras el 202 el formulario sigue visible');
  check(t.toolOtherWrap.hidden === true, '3: tras el 202 la caja de "Otra" sigue visible');
  for (const id of ['#wl-name', '#wl-email', '#wl-tool-other']) check(t.form.querySelector(id).value === '', `3: ${id} no quedó vacío tras el 202`);
  check(t.form.querySelector('#wl-privacy').checked === false, '3: la casilla de privacidad sigue marcada tras el 202');
  check(t.status.textContent === '', '3: el estado "Enviando…" no se limpió tras el 202');
  // Token descartado: un nuevo foco pide otro.
  t.form.dispatch('focusin');
  await sleep(20);
  check(tokenCalls(t).length === 2, '3: tras el 202 el token no se descartó (no se pidió otro)');
  for (const c of t.net.calls) check(c.init.credentials === 'omit' && c.init.mode === 'cors', '6: petición sin credentials omit / mode cors');
  check(t.storageHits.length === 0, `6: se accedió a ${[...new Set(t.storageHits)].join(', ')}`);
}

/* ---- 4. Tras un 400 o un 429 el token no se reenvía ---- */
for (const status of [400, 429, 413, 415]) {
  const t = load();
  t.net.queue.post.push({ status, body: { statusCode: status, message: ['x'] } });
  t.form.dispatch('focusin');
  await sleep(10);
  fill(t);
  await submitAndWait(t);
  const msg = t.status.textContent;
  if (status === 429) check(/demasiados intentos/.test(msg), `7: mensaje del 429 inesperado: "${msg}"`);
  else check(/No hemos podido apuntarte|Algo ha fallado/.test(msg), `7: mensaje del ${status} inesperado: "${msg}"`);
  await submitAndWait(t);
  const p = posts(t);
  check(p.length === 2, `4 (${status}): se esperaban 2 envíos y hubo ${p.length}`);
  if (p.length === 2) check(p[0].body.formToken !== p[1].body.formToken, `4 (${status}): se reenvió el mismo token`);
  check(tokenCalls(t).length === 2, `4 (${status}): no se pidió un token nuevo para el segundo envío`);
}

/* ---- 5. Reintentos únicos ---- */
{
  const t = load();
  t.net.queue.post.push({ status: 400, body: { statusCode: 400, code: 'WAITLIST_FORM_TOO_FAST' } });
  t.form.dispatch('focusin');
  await sleep(10);
  fill(t);
  await submitAndWait(t, 1000);
  const p = posts(t);
  check(p.length === 2 && p[0].body.formToken === p[1].body.formToken, '5: TOO_FAST no reintentó una vez con el mismo token');
  check(t.done.hidden === false, '5: tras el reintento con 202 no se muestra el mensaje final');
}
{
  const t = load();
  t.net.queue.post.push({ status: 400, body: { statusCode: 400, code: 'WAITLIST_FORM_TOKEN_INVALID' } });
  t.net.queue.post.push({ status: 400, body: { statusCode: 400, code: 'WAITLIST_FORM_TOKEN_INVALID' } });
  t.form.dispatch('focusin');
  await sleep(10);
  fill(t);
  await submitAndWait(t, 1000);
  const p = posts(t);
  check(p.length === 2, `5: TOKEN_INVALID debe reintentar una sola vez (hubo ${p.length} envíos)`);
  if (p.length === 2) check(p[0].body.formToken !== p[1].body.formToken, '5: TOKEN_INVALID reintentó con el mismo token');
  check(t.done.hidden === true, '5: dos TOKEN_INVALID no deben mostrar el mensaje de éxito');
}

/* ---- 8. "¿Qué usas hoy?": opcional, opción tal cual, "Otra" con y sin texto, máx. 100 ---- */
for (const [opts, expected] of [
  [{}, undefined],
  [{ tool: 'Excel / hojas de cálculo' }, 'Excel / hojas de cálculo'],
  [{ tool: 'Otra', toolOther: '' }, 'Otra'],
]) {
  const t = load();
  t.form.dispatch('focusin');
  await sleep(10);
  fill(t, opts);
  await submitAndWait(t);
  const p = posts(t);
  check(p.length === 1, `8 (${expected}): se esperaba 1 envío y hubo ${p.length}`);
  if (p[0]) check(p[0].body.tools === expected, `8: se esperaba tools=${expected} y llegó ${p[0].body.tools}`);
  if (p[0]) check(!Object.keys(p[0].body).some((k) => k.startsWith('commercialConsent')), '8: se envió un campo commercialConsent*');
}
{
  const t = load();
  t.form.dispatch('focusin');
  await sleep(10);
  fill(t, { tool: 'Otra', toolOther: 'x'.repeat(101) });
  await submitAndWait(t);
  check(posts(t).length === 0, '8: "Otra" con más de 100 caracteres se envió');
  check(t.form.querySelector('#wl-tool-other').getAttribute('aria-invalid') === 'true', '8: "Otra" larga no se marcó como inválida');
  // Al cambiar a otra opción, la caja se oculta y se vacía.
  const r = t.form.querySelectorAll('input[name="currentTool"]').find((x) => x.value === 'Eholo');
  for (const x of t.form.querySelectorAll('input[name="currentTool"]')) x.checked = false;
  r.checked = true; r.dispatch('change');
  check(t.toolOtherWrap.hidden === true && t.form.querySelector('#wl-tool-other').value === '', '8: al dejar "Otra" la caja no se ocultó ni se vació');
}

/* ---- 7. Red caída (un reintento automático) y validación sin red ---- */
{
  const t = load();
  t.form.dispatch('focusin');
  await sleep(10);
  t.net.queue.post.push('network');
  fill(t);
  await submitAndWait(t, 2600);
  const p = posts(t);
  check(p.length === 2, `7: un fallo de red debe reintentar una vez (hubo ${p.length} envíos)`);
  if (p.length === 2) check(p[0].body.formToken === p[1].body.formToken, '7: el reintento tras un fallo de red no conservó el token');
  check(t.done.hidden === false, '7: el reintento con 202 no mostró el mensaje final');
}
{
  const t = load();
  t.form.dispatch('focusin');
  await sleep(10);
  t.net.queue.post.push('network', 'network');
  fill(t);
  await submitAndWait(t, 2600);
  check(posts(t).length === 2, `7: con dos fallos de red debe haber 2 envíos (hubo ${posts(t).length})`);
  check(/No hemos podido conectar/.test(t.status.textContent), `7: mensaje de red inesperado: "${t.status.textContent}"`);
  check(t.form.querySelector('#wl-name').value !== '', '7: tras un fallo de red se borraron los datos escritos');
  check(t.section.querySelector('[data-wl-submit]').getAttribute('aria-disabled') === 'false', '7: tras el error el botón sigue deshabilitado');
}
{
  const t = load();
  await submitAndWait(t);
  check(posts(t).length === 0 && t.net.calls.length === 1, '7: un formulario vacío hizo peticiones (aparte del token de la carga)');
  check(t.form.querySelector('#wl-name').getAttribute('aria-invalid') === 'true', '7: el nombre vacío no se marcó como inválido');
  check(doc.activeElement && doc.activeElement.id === 'wl-name', '7: el foco no fue al primer campo con error');
  check(/marca la casilla de privacidad/.test(doc.getElementById('wl-privacy-err').textContent), '7: falta el error de la casilla de privacidad');
}

{ // 9. Versión de la política: la que envía la landing = la visible = la del contrato, y la API la acepta (si no, 400).
  const sent = (configSrc.match(/WAITLIST_POLICY_VERSION:\s*'([^']+)'/) || [])[1];
  const page = readFileSync(join(pub, 'privacidad-lista-espera/index.html'), 'utf8');
  const shown = (page.match(/Versión:\s*(lista-espera-v\d+)/) || [])[1];
  const contract = (readFileSync(join(repoRoot, 'packages/contracts/src/waitlist.ts'), 'utf8').match(/WAITLIST_PRIVACY_POLICY_VERSION = '([^']+)'/) || [])[1];
  const apiList = (readFileSync(join(repoRoot, 'apps/api/src/waitlist/waitlist.config.ts'), 'utf8').match(/ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS = \[([^\]]*)\]/) || [])[1] || '';
  const accepted = [...apiList.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  check(sent && sent === shown, `9: config.js envía "${sent}" pero la página muestra "${shown}"`);
  check(sent === contract, `9: config.js envía "${sent}" pero packages/contracts dice "${contract}"`);
  check(accepted.includes(sent), `9: la API no acepta "${sent}" (acepta ${accepted.join(', ')})`);
  // Las versiones archivadas que acepta la API o enlaza la vigente tienen su página, con noindex.
  // Las posteriores a la que envía la landing (la API ya acepta la siguiente antes de que la landing la publique) no.
  const num = (x) => Number((x.match(/-v(\d+)$/) || [])[1]);
  for (const v of accepted.filter((x) => x !== sent && num(x) < num(sent))) {
    const n = v.replace('lista-espera-', '');
    check(page.includes(`href="/privacidad-lista-espera/${n}/"`), `9: la política vigente no enlaza la archivada /${n}/`);
    let old = '';
    try { old = readFileSync(join(pub, `privacidad-lista-espera/${n}/index.html`), 'utf8'); } catch { /* falta */ }
    check(old.includes(`Versión: ${v}`), `9: falta la política archivada ${v} en /privacidad-lista-espera/${n}/`);
    check(old.includes('<meta name="robots" content="noindex">'), `9: /privacidad-lista-espera/${n}/ sin noindex`);
  }
}

/* ---- 10. Arranque en frío (temporizadores divididos entre 1000: 6 s = 6 ms, 20 s = 20 ms, 90 s = 90 ms) ---- */
{ // La API no responde: mensajes progresivos, sin doble envío, timeout a los 90 s y SIN reintento.
  const t = load({ timeScale: 1000, post: ['hang'] });
  await sleep(10);
  fill(t);
  t.form.dispatch('submit');
  await sleep(12);
  check(/puede tardar unos segundos/.test(t.status.textContent), `10: a los 6 s falta el aviso de espera ("${t.status.textContent}")`);
  t.form.dispatch('submit');
  await sleep(18);
  check(/despertando el servidor/.test(t.status.textContent) && /No cierres la página/.test(t.status.textContent), `10: a los 20 s falta el aviso de despertar ("${t.status.textContent}")`);
  check(t.section.querySelector('[data-wl-submit]').getAttribute('aria-disabled') === 'true', '10: el botón no está deshabilitado mientras espera');
  await sleep(150);
  check(posts(t).length === 1, `10: hubo ${posts(t).length} envíos (doble envío o reintento tras timeout)`);
  check(/No hemos podido conectar/.test(t.status.textContent), `10: tras 90 s sin respuesta falta el error ("${t.status.textContent}")`);
}
{ // La API tarda 50 s (dentro de los 90): sale bien y se vio el aviso de despertar.
  const t = load({ timeScale: 1000, post: [{ delay: 50, status: 202, body: { status: 'accepted' } }] });
  await sleep(10);
  fill(t);
  t.form.dispatch('submit');
  await sleep(35);
  check(/despertando el servidor/.test(t.status.textContent), '10: con 50 s de espera no salió el aviso de despertar');
  await sleep(60);
  check(t.done.hidden === false && posts(t).length === 1, '10: una respuesta a los 50 s no completó el alta');
}
{ // El token de la carga aún no ha llegado al enviar: el envío espera a ESE token (no pide otro).
  const t = load({ token: [{ delay: 300, status: 200, body: { formToken: 'tok-lento', minSeconds: 0 } }] });
  fill(t);
  t.form.dispatch('focusin');
  await submitAndWait(t, 700);
  check(tokenCalls(t).length === 1, `10: con el token en curso se pidieron ${tokenCalls(t).length} tokens`);
  check(posts(t).length === 1 && posts(t)[0].body.formToken === 'tok-lento', '10: el envío no usó el token que se estaba pidiendo');
  check(t.done.hidden === false, '10: el envío tras esperar el token no terminó');
}

if (failures.length) {
  for (const f of failures) console.error(`ERROR   ${f}`);
  console.error(`\ncheck-landing-form: ${failures.length} fallo(s).`);
  process.exit(1);
}
console.log('check-landing-form: OK (fetch simulado: token al cargar, minSeconds, 202, 400/413/415/429, reintentos, red con un reintento, arranque en frío (6/20/90 s), validación, herramienta actual, sin casilla comercial, sin almacenamiento, versión de la política).');
