import { describe, expect, it } from '@jest/globals';
import {
  SUPPORT_COMMITMENT,
  SUPPORT_DISCLAIMER,
  SUPPORT_EMAIL,
  SUPPORT_NO_PATIENT_DATA,
  SUPPORT_NO_PATIENT_DATA_DETAIL,
  SUPPORT_SUBJECT,
  supportMailto,
} from '../lib/support';

describe('Soporte, fase 0', () => {
  it('el compromiso recoge 1 día laborable y 4 horas laborables, y se presenta como informativo', () => {
    const text = SUPPORT_COMMITMENT.join(' ');
    expect(text).toMatch(/1 día laborable/);
    expect(text).toMatch(/4 horas laborables/);
    expect(SUPPORT_DISCLAIMER).toMatch(/informativos/);
    expect(SUPPORT_DISCLAIMER).toMatch(/no una garantía/);
  });

  it('avisa de no incluir datos de pacientes ni contraseñas o códigos', () => {
    expect(SUPPORT_NO_PATIENT_DATA).toBe('No incluyas datos de pacientes.');
    expect(SUPPORT_NO_PATIENT_DATA_DETAIL).toMatch(/contraseña/);
    expect(SUPPORT_NO_PATIENT_DATA_DETAIL).toMatch(/código de verificación/);
  });

  it('el enlace de correo usa el buzón y solo lleva el asunto, sin cuerpo ni datos', () => {
    const link = supportMailto(SUPPORT_SUBJECT);
    expect(link.startsWith(`mailto:${SUPPORT_EMAIL}?subject=`)).toBe(true);
    expect(link).not.toMatch(/body=/);
  });
});
