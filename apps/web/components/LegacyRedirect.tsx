'use client';

import { ReactNode, useEffect, useState } from 'react';
import { legacyToStatic } from '@/lib/routes';

/*
 * Export estático: la 404 se publica como 404.html. Si la URL tiene el formato antiguo
 * (/patients/<id>/plan, /agenda/<id>: marcadores o enlaces anteriores a la salida de Vercel),
 * redirige a la ruta nueva con el id en la query (solo ids validados, ver legacyToStatic).
 * Si no, muestra la 404 normal (children).
 */
export default function LegacyRedirect({ children }: Readonly<{ children: ReactNode }>) {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const target = legacyToStatic(window.location.pathname + window.location.search + window.location.hash);
    if (target) {
      window.location.replace(target);
      return;
    }
    setChecking(false);
  }, []);

  if (checking) return null;
  return <>{children}</>;
}
