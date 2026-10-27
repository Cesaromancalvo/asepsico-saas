'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { queryId } from '@/lib/routes';

/*
 * Pantallas con id en la query: si `id` (y `processId` en la de proceso) no tiene forma de cuid,
 * no se monta la página, así que nunca se llama a la API con un id manipulado.
 */
export default function QueryIdGuard({ children }: Readonly<{ children: React.ReactNode }>) {
  const params = useSearchParams();
  const pathname = usePathname() ?? '';
  const required = pathname.startsWith('/patients/view/process') ? ['id', 'processId'] : ['id'];
  if (required.every((k) => queryId(params.get(k)))) return <>{children}</>;
  return (
    <main style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px' }}>
      <h1>Enlace no válido</h1>
      <p>La dirección está incompleta o mal formada.</p>
      <p><Link href="/">Volver al inicio</Link></p>
    </main>
  );
}
