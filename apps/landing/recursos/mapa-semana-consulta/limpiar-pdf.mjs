#!/usr/bin/env node
/**
 * Limpia los metadatos del PDF que genera Chrome sin interfaz, sin cambiar la longitud del archivo (las
 * posiciones de la tabla xref siguen valiendo): /Creator (el user agent de Chrome, con versión y sistema)
 * pasa a /Author (AsePsico) y /Producer (Skia) a /Creator (AsePsico), rellenando con espacios. Comprueba
 * además que el PDF no lleva JavaScript, formularios, enlaces externos ni XMP. Sin dependencias.
 * Uso: node limpiar-pdf.mjs archivo.pdf
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
let pdf = readFileSync(file).toString('latin1');
const swap = (re, value) => {
  const m = pdf.match(re);
  if (!m) throw new Error(`no encuentro ${re}`);
  if (value.length > m[0].length) throw new Error(`${value} no cabe en ${m[0].length} bytes`);
  pdf = pdf.replace(m[0], value.padEnd(m[0].length, ' '));
};
swap(/\/Creator \((?:\\.|[^\\)])*\)/, '/Author (AsePsico)');
swap(/\/Producer \((?:\\.|[^\\)])*\)/, '/Creator (AsePsico)');
for (const bad of ['/JavaScript', '/JS ', '/AcroForm', '/URI', '/Launch', '/Metadata', 'HeadlessChrome', 'Mozilla']) {
  if (pdf.includes(bad)) throw new Error(`el PDF contiene ${bad}`);
}
if (!pdf.includes('/StructTreeRoot')) throw new Error('el PDF no está etiquetado (accesibilidad)');
writeFileSync(file, Buffer.from(pdf, 'latin1'));
console.log(`limpiar-pdf: OK (${file})`);
