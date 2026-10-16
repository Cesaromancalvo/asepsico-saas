'use client';

import { useEffect, useState } from 'react';
import type { PublicEnvironmentContract } from '@asepsico/contracts';
import { api } from './api';

/*
 * ¿Estamos en un entorno de prueba (piloto demo, solo datos inventados)?
 *
 * Lo dice GET /environment (público). Falla hacia el lado seguro, igual que la API: mientras no hay
 * respuesta, o si la llamada falla, se considera demo y el aviso se muestra. Solo { demo: false }
 * explícito lo oculta (entorno del piloto real, con el contrato art. 28 aceptado).
 */

let environmentCache: Promise<boolean> | null = null;

export function fetchIsDemoEnvironment(): Promise<boolean> {
  if (environmentCache) return environmentCache;
  environmentCache = api<PublicEnvironmentContract>('/environment')
    .then((env) => env?.demo !== false)
    .catch(() => {
      // Un fallo puntual no se cachea: la próxima pantalla lo vuelve a intentar.
      environmentCache = null;
      return true;
    });
  return environmentCache;
}

/** true salvo que la API diga explícitamente { demo: false }. */
export function useIsDemoEnvironment(): boolean {
  const [demo, setDemo] = useState(true);
  useEffect(() => {
    let cancelled = false;
    fetchIsDemoEnvironment().then((value) => {
      if (!cancelled) setDemo(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return demo;
}

/** Microcopys de apoyo del piloto demo (texto de Lex Psi, aviso-entorno-prueba.md §2). */
export const DEMO_HINT = {
  newPatient: 'Inventa este paciente. No uses nombres, iniciales ni datos de personas reales.',
  clinicalFreeText: 'Solo contenido inventado.',
  portalEmail: 'Usa una dirección tuya de prueba, nunca la de otra persona.',
  teamInvite: 'Recuerda a esta persona que en la prueba solo se usan datos inventados.',
  attachments: 'No subas documentos reales.',
} as const;
