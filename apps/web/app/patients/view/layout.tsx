import { Suspense } from 'react';
import QueryIdGuard from '@/components/QueryIdGuard';

// Export estático: las páginas de aquí leen el id con useSearchParams(), que exige un
// <Suspense> por encima para que el build no falle (la query solo existe en el navegador).
// QueryIdGuard no monta la página si el id no tiene forma de cuid.
export default function QueryIdLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <Suspense fallback={null}><QueryIdGuard>{children}</QueryIdGuard></Suspense>;
}
