'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useIsDemoEnvironment } from '@/lib/environment';

/** Apartado 4 ("Solo datos inventados") de las condiciones del piloto demo en /legal. */
export const DEMO_RULES_HREF = '/legal#doc-PILOT_TERMS-apartado-4';

function isPatientPortal(pathname: string | null) {
  return pathname === '/portal' || !!pathname?.startsWith('/portal/');
}

/**
 * Aviso fijo "Entorno de prueba" (texto de Lex Psi, aviso-entorno-prueba.md §1 y §3).
 *
 * - En todas las pantallas (va en el layout raíz), también antes de iniciar sesión y en el portal
 *   del paciente, con su propio texto.
 * - Sin botón de cerrar. Se muestra mientras no hay respuesta y si GET /environment falla.
 * - Va en el flujo del documento (no tapa nada) y se queda pegado arriba al hacer scroll. Publica
 *   su altura en --demo-banner-height para que la barra lateral fija y los anclajes no queden debajo.
 */
export default function DemoBanner() {
  const demo = useIsDemoEnvironment();
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    const node = ref.current;
    if (!demo || !node) {
      root.style.removeProperty('--demo-banner-height');
      return;
    }
    const update = () => root.style.setProperty('--demo-banner-height', `${node.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--demo-banner-height');
    };
  }, [demo]);

  if (!demo) return null;

  const portal = isPatientPortal(pathname);
  return (
    <div ref={ref} className="demo-banner" role="note" aria-label={portal ? 'Portal de prueba' : 'Entorno de prueba'}>
      {/* Banda fina: etiqueta en chip ámbar + texto íntegro de Lex Psi (los dos puntos solo para lectores de pantalla). */}
      {portal ? (
        <p>
          <strong className="demo-banner-chip"><span className="demo-banner-dot" aria-hidden="true" />Portal de prueba<span className="sr-only">:</span></strong> todos los datos son inventados.
        </p>
      ) : (
        <p>
          <strong className="demo-banner-chip"><span className="demo-banner-dot" aria-hidden="true" />Entorno de prueba<span className="sr-only">:</span></strong> usa solo datos inventados. No introduzcas datos de pacientes reales ni datos
          de salud de nadie.{' '}
          <Link href={DEMO_RULES_HREF}>
            Más información<span className="sr-only"> sobre el uso de datos inventados en las condiciones del piloto demo</span>
          </Link>
        </p>
      )}
    </div>
  );
}
