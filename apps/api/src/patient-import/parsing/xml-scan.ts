import { ImportFileError } from './import-file-error';

/**
 * Recorrido lineal del subconjunto de XML de SpreadsheetML que necesitamos, SIN construir un
 * árbol (condición de Argos: el árbol de un XML de varios MB ocupa más de 10 veces su tamaño).
 *
 * - Solo indexOf hacia delante: cada carácter se visita un número acotado de veces (sin regex
 *   con retroceso sobre el documento, sin riesgo de ReDoS cuadrático).
 * - Una etiqueta abierta sin cierre invalida el fichero en el acto.
 * - Cualquier DOCTYPE/ENTITY se rechaza: sin DTD no hay entidades externas ni expansión; solo se
 *   decodifican las 5 entidades predefinidas y las referencias numéricas.
 * - Los prefijos de espacio de nombres (`x:row`) se aceptan en elementos y atributos.
 */

export interface XmlElement {
  attrs: string;
  /** Contenido entre la etiqueta de apertura y la de cierre ('' si es autocerrada). */
  inner: string;
}

const NAME_END = new Set([' ', '\t', '\r', '\n', '/', '>']);

export function decodeXmlPart(part: Buffer | undefined): string {
  if (!part) throw new ImportFileError('INVALID_XLSX');
  // UTF-16 (con BOM, o NUL intercalados al principio): no se admite, con un error claro en vez de
  // leerlo como UTF-8 y acabar en "fichero vacío".
  const head = part.subarray(0, 64);
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff) || head.includes(0)) {
    throw new ImportFileError('UNSUPPORTED_ENCODING');
  }
  const text = new TextDecoder('utf-8').decode(part);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new ImportFileError('INVALID_XLSX');
  return text;
}

const isNameChar = (ch: string | undefined) => ch !== undefined && /[\w.-]/.test(ch);
const MAX_NAME = 64;

/** Lee un nombre cualificado acotado (`row`, `x:row`) desde `at`. Devuelve [local, fin]. */
function readName(xml: string, at: number): [string, number] {
  let k = at;
  while (k < at + MAX_NAME && isNameChar(xml[k])) k += 1;
  let start = at;
  if (xml[k] === ':' && k > at) {
    start = k + 1;
    k = start;
    while (k < start + MAX_NAME && isNameChar(xml[k])) k += 1;
  }
  return [xml.slice(start, k), k];
}

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/**
 * Busca `token` desde `from` saltando las secciones CDATA (su contenido es texto: un "</t>" o un
 * "<c" dentro de CDATA no es marcado). Lineal: cada CDATA se recorre una sola vez.
 */
// Memo de "siguiente CDATA a partir de" por texto: sin él, cada búsqueda volvería a recorrer el
// documento hasta el final (cuadrático). Se vacía al terminar cada lectura (resetXmlScan).
const cdataMemo = new Map<string, { from: number; at: number }>();

function nextCdata(xml: string, cursor: number): number {
  const memo = cdataMemo.get(xml);
  if (memo && cursor >= memo.from && (memo.at === -1 || cursor <= memo.at)) return memo.at;
  const at = xml.indexOf(CDATA_OPEN, cursor);
  if (cdataMemo.size >= 16) cdataMemo.clear();
  cdataMemo.set(xml, { from: cursor, at });
  return at;
}

export function resetXmlScan(): void {
  cdataMemo.clear();
}

function indexOutsideCdata(xml: string, token: string, from: number): number {
  let cursor = from;
  for (;;) {
    const i = xml.indexOf(token, cursor);
    const cdata = nextCdata(xml, cursor);
    if (i === -1) return -1;
    if (cdata === -1 || cdata > i) return i;
    const end = xml.indexOf(CDATA_CLOSE, cdata + CDATA_OPEN.length);
    if (end === -1) throw new ImportFileError('INVALID_XLSX'); // CDATA sin cerrar
    cursor = end + CDATA_CLOSE.length;
  }
}

/** Busca la siguiente etiqueta de apertura `<name` o `<prefijo:name` a partir de `from`. */
function findOpen(xml: string, name: string, from: number, to: number): { start: number; nameEnd: number } | null {
  let i = indexOutsideCdata(xml, '<', from);
  while (i !== -1 && i < to) {
    const [local, end] = readName(xml, i + 1);
    if (local === name && NAME_END.has(xml[end])) return { start: i, nameEnd: end };
    i = indexOutsideCdata(xml, '<', i + 1);
  }
  return null;
}

/** Busca el cierre `</name>` o `</prefijo:name>` desde `from`. Devuelve [inicio, fin]. */
function findClose(xml: string, name: string, from: number, to: number): [number, number] | null {
  let i = indexOutsideCdata(xml, '</', from);
  while (i !== -1 && i < to) {
    const [local, end] = readName(xml, i + 2);
    let k = end;
    while (k < end + 8 && /\s/.test(xml[k] ?? '')) k += 1;
    if (local === name && xml[k] === '>') return [i, k + 1];
    i = indexOutsideCdata(xml, '</', i + 2);
  }
  return null;
}

/**
 * Contenido de texto de un elemento: las secciones CDATA se toman tal cual (sin decodificar
 * entidades, como manda XML) y el resto se decodifica.
 */
export function textContent(raw: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const cdata = raw.indexOf(CDATA_OPEN, cursor);
    if (cdata === -1) return out + decodeEntities(raw.slice(cursor));
    const end = raw.indexOf(CDATA_CLOSE, cdata + CDATA_OPEN.length);
    if (end === -1) throw new ImportFileError('INVALID_XLSX');
    out += decodeEntities(raw.slice(cursor, cdata)) + raw.slice(cdata + CDATA_OPEN.length, end);
    cursor = end + CDATA_CLOSE.length;
  }
}

/**
 * Recorre los elementos `name` (sin anidar el mismo nombre, que en SpreadsheetML no ocurre en las
 * etiquetas que usamos) entre `from` y `to`. `onElement` devuelve false para parar.
 */
export function eachElement(
  xml: string,
  name: string,
  onElement: (el: XmlElement) => boolean | void,
  from = 0,
  to = xml.length,
): void {
  let cursor = from;
  for (;;) {
    const open = findOpen(xml, name, cursor, to);
    if (!open) return;
    const tagEnd = xml.indexOf('>', open.nameEnd);
    if (tagEnd === -1 || tagEnd >= to) throw new ImportFileError('INVALID_XLSX');
    const selfClosing = xml[tagEnd - 1] === '/';
    const attrs = xml.slice(open.nameEnd, selfClosing ? tagEnd - 1 : tagEnd);
    if (selfClosing) {
      cursor = tagEnd + 1;
      if (onElement({ attrs, inner: '' }) === false) return;
      continue;
    }
    const close = findClose(xml, name, tagEnd + 1, to);
    if (!close) throw new ImportFileError('INVALID_XLSX');
    cursor = close[1];
    if (onElement({ attrs, inner: xml.slice(tagEnd + 1, close[0]) }) === false) return;
  }
}

export function firstElement(xml: string, name: string): XmlElement | null {
  let found: XmlElement | null = null;
  eachElement(xml, name, (el) => {
    found = el;
    return false;
  });
  return found;
}

/** Valor de un atributo (con o sin prefijo: `id` encuentra `r:id`, pero no `sheetId`). */
export function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)(?:[A-Za-z_][\\w.-]*:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const match = re.exec(attrs);
  return match ? decodeEntities(match[2] ?? match[3] ?? '') : undefined;
}

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (_m, ent: string) => {
    switch (ent) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const code = ent.startsWith('#x') ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        // Fuera: NUL, el rango de surrogates (U+D800–U+DFFF: dejaría un surrogate suelto que la
        // base de datos rechaza) y lo que pasa de U+10FFFF.
        if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
        return String.fromCodePoint(code);
      }
    }
  });
}

/**
 * Texto de un `<si>` o `<is>`: concatena los `<t>`, incluido el texto enriquecido (`<r><t>`), y
 * descarta la fonética (`<rPh>`).
 */
export function richText(inner: string): string {
  let text = '';
  let cursor = 0;
  // La siguiente fonética se busca una sola vez y solo se vuelve a buscar al dejarla atrás.
  let nextPh = findOpen(inner, 'rPh', 0, inner.length);
  for (;;) {
    if (nextPh && nextPh.start < cursor) nextPh = findOpen(inner, 'rPh', cursor, inner.length);
    const nextT = findOpen(inner, 't', cursor, nextPh ? nextPh.start : inner.length);
    if (!nextT && nextPh) {
      const close = findClose(inner, 'rPh', nextPh.nameEnd, inner.length);
      if (!close) throw new ImportFileError('INVALID_XLSX');
      cursor = close[1];
      nextPh = findOpen(inner, 'rPh', cursor, inner.length);
      continue;
    }
    if (!nextT) return text;
    const tagEnd = inner.indexOf('>', nextT.nameEnd);
    if (tagEnd === -1) throw new ImportFileError('INVALID_XLSX');
    if (inner[tagEnd - 1] === '/') {
      cursor = tagEnd + 1;
      continue;
    }
    const close = findClose(inner, 't', tagEnd + 1, inner.length);
    if (!close) throw new ImportFileError('INVALID_XLSX');
    text += textContent(inner.slice(tagEnd + 1, close[0]));
    cursor = close[1];
  }
}

/** Texto de un elemento hijo simple (`<v>`). */
export function childText(inner: string, name: string): string {
  const el = firstElement(inner, name);
  return el ? textContent(el.inner) : '';
}
