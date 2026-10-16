/**
 * Catálogo de escalas con su corrección (puntuación → gravedad e interpretación). Lo usan
 * PatientAssessmentsService y el seed del espacio de demostración, para que ambos puntúen igual.
 */
export const CLINICAL_SCALES = {
  PHQ9: {
    code: 'PHQ9', name: 'PHQ-9', questionCount: 9, min: 0, max: 3,
    severity(score: number) {
      if (score <= 4) return ['Mínima', 'Síntomas depresivos mínimos.'];
      if (score <= 9) return ['Leve', 'Sintomatología depresiva leve; valorar seguimiento clínico.'];
      if (score <= 14) return ['Moderada', 'Sintomatología depresiva moderada.'];
      if (score <= 19) return ['Moderadamente grave', 'Sintomatología depresiva moderadamente grave.'];
      return ['Grave', 'Sintomatología depresiva grave; requiere valoración clínica prioritaria.'];
    },
  },
  GAD7: {
    code: 'GAD7', name: 'GAD-7', questionCount: 7, min: 0, max: 3,
    severity(score: number) {
      if (score <= 4) return ['Mínima', 'Síntomas de ansiedad mínimos.'];
      if (score <= 9) return ['Leve', 'Sintomatología ansiosa leve; valorar seguimiento.'];
      if (score <= 14) return ['Moderada', 'Sintomatología ansiosa moderada.'];
      return ['Grave', 'Sintomatología ansiosa grave; requiere valoración clínica.'];
    },
  },
  WHO5: {
    code: 'WHO5', name: 'WHO-5', questionCount: 5, min: 0, max: 5,
    severity(score: number) {
      const percentage = score * 4;
      if (percentage >= 72) return ['Bienestar alto', `Índice de bienestar ${percentage}/100.`];
      if (percentage >= 52) return ['Bienestar adecuado', `Índice de bienestar ${percentage}/100.`];
      if (percentage >= 28) return ['Bienestar reducido', `Índice de bienestar ${percentage}/100; conviene exploración clínica.`];
      return ['Bienestar muy reducido', `Índice de bienestar ${percentage}/100; valorar síntomas depresivos.`];
    },
  },
} as const;
