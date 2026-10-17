'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { legacyToStatic } from '@/lib/routes';

/*
 * 404 del sitio estático (se publica como 404.html). Si la URL tiene el formato antiguo
 * (/patients/<id>/plan, /agenda/<id>: marcadores o enlaces anteriores a la salida de Vercel),
 * redirige a la ruta nueva con el id en la query. Si no, muestra el 404 normal.
 */
export default function NotFound() {
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
  return (
    <main style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px' }}>
      <h1>Página no encontrada</h1>
      <p>La dirección no existe o ha cambiado.</p>
      <p><Link href="/">Volver al inicio</Link></p>
    </main>
  );
}
