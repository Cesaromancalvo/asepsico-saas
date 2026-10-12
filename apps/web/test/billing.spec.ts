import { describe, expect, it } from '@jest/globals';
import { freeText, HIDDEN_FOR_ROLE, lineLabel } from '../lib/billing';

describe('Facturación: textos libres ocultos para recepción', () => {
  it('con el indicador Hidden se enseña HIDDEN_FOR_ROLE ("No visible con tu rol"), aunque el valor llegue a null', () => {
    expect(freeText(null, true)).toEqual({ text: HIDDEN_FOR_ROLE, hidden: true });
    expect(freeText('texto', true)).toEqual({ text: HIDDEN_FOR_ROLE, hidden: true });
  });

  it('sin indicador: el valor si tiene contenido; nada si está vacío', () => {
    expect(freeText('Transferencia 123', undefined)).toEqual({ text: 'Transferencia 123', hidden: false });
    expect(freeText(null, undefined)).toBeNull();
    expect(freeText('   ', undefined)).toBeNull();
  });

  it('una línea antigua oculta se enseña como "Otro concepto"', () => {
    expect(lineLabel({ description: 'Otro concepto', legacyDescriptionHidden: true })).toBe('Otro concepto');
    expect(lineLabel({ description: 'Sesión individual' })).toBe('Sesión individual');
  });
});
