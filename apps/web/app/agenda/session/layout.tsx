import { Suspense } from 'react';

// Export estático: las páginas de aquí leen el id con useSearchParams(), que exige un
// <Suspense> por encima para que el build no falle (la query solo existe en el navegador).
export default function QueryIdLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
