import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatShortDateTime } from '../lib/date-format';

/*
 * Fallos visuales del recorrido de demo (14/11): fila de «Tareas por revisar», tarjetas de resumen
 * de la ficha, barra lateral plegada y formato único de fechas en Mensajes. Datos ficticios.
 */

jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...rest }: { href: string; children?: unknown }) => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return createElement('a', { href, ...rest }, children as never);
} }));

const css = readFileSync(join(__dirname, '..', 'app', 'design-system.css'), 'utf8');

describe('Mensajes: formato de fecha único', () => {
  it('muestra «25 oct 2026, 22:03» (sin segundos ni formato numérico)', () => {
    // Fecha local: el resultado no depende de la zona horaria de la máquina.
    expect(formatShortDateTime(new Date(2026, 9, 25, 22, 3, 27))).toBe('25 oct 2026, 22:03');
    expect(formatShortDateTime(new Date(2026, 10, 5, 9, 7, 0))).toBe('5 nov 2026, 09:07');
  });

  it('sin fecha o con una fecha inválida, devuelve el texto de vacío', () => {
    expect(formatShortDateTime(undefined)).toBe('Sin actividad');
    expect(formatShortDateTime(null)).toBe('Sin actividad');
    expect(formatShortDateTime('no-es-fecha')).toBe('Sin actividad');
  });

  it('la lista etiqueta la fecha como «Última actividad» y los mensajes usan el mismo formato', () => {
    const page = readFileSync(join(__dirname, '..', 'app', 'messages', 'page.tsx'), 'utf8');
    expect(page).toContain('Última actividad: {formatDateTime(c.lastActivityAt ?? c.updatedAt)}');
    expect(page).not.toContain("toLocaleString('es-ES')");
    const portal = readFileSync(join(__dirname, '..', 'app', 'portal', 'page.tsx'), 'utf8');
    expect(portal).toContain('formatShortDateTime(m.createdAt)');
  });
});

describe('Tareas por revisar: fila a todo el ancho', () => {
  it('usa su propia rejilla: texto + acción, sin la columna de icono de Mi jornada', async () => {
    const { default: TaskReviewRow } = await import('../components/TaskReviewRow');
    const html = renderToStaticMarkup(
      <TaskReviewRow href="/patients/tasks?id=p1&amp;filter=review" title="[Ejemplo ficticio] Buscar una actividad de grupo" subtitle="Ana Prueba" />,
    );
    expect(html).toContain('class="task-row review-task-row"');
    expect(html).toContain('<span class="review-task-copy"><strong>[Ejemplo ficticio] Buscar una actividad de grupo</strong><small>Ana Prueba</small></span>');
    expect(html).toContain('<span class="review-task-action">Revisar</span>');
    expect(css).toMatch(/\.task-row\.review-task-row\{grid-template-columns:minmax\(0,1fr\) auto;/);
    // En móvil, una sola columna: «Revisar» pasa debajo.
    expect(css).toMatch(/@media\(max-width:560px\)\{\s*\.task-row\.review-task-row\{grid-template-columns:minmax\(0,1fr\)\}/);
  });
});

describe('Ficha del paciente y barra lateral', () => {
  it('los valores de las tarjetas de resumen hacen salto de línea en vez de elipsis', () => {
    expect(css).toContain('.patient-summary-card>strong{overflow:visible;white-space:normal;text-overflow:clip;');
  });

  it('con la barra plegada (701–900 px) se oculta el texto de la marca en lugar de cortarlo', async () => {
    expect(css).toMatch(/@media\(min-width:701px\) and \(max-width:900px\)\{\s*\.sidebar-brand>div:last-child\{display:none\}/);
    const { SIDEBAR_COLLAPSED_QUERY } = await import('../components/Sidebar');
    expect(SIDEBAR_COLLAPSED_QUERY).toBe('(min-width: 701px) and (max-width: 900px)');
  });
});
