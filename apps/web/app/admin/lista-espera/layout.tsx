import type { Metadata } from 'next';

// Panel privado: fuera de buscadores y sin referrer (además de las cabeceras de next.config.mjs).
export const metadata: Metadata = {
  title: 'Lista de espera · AsePsico',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function WaitlistPanelLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
