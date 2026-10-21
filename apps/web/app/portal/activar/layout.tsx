import type { Metadata } from 'next';

// Página pública del alta en el portal: sin indexar y sin enviar el referrer (el token va en el
// fragmento de la URL, que nunca sale del navegador, pero se evita cualquier fuga a terceros).
export const metadata: Metadata = {
  title: 'Portal del paciente · AsePsico',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function PublicPortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
