import type { Metadata } from 'next';

// Panel privado: fuera de buscadores y sin referrer (además de las cabeceras de next.config.mjs).
export const metadata: Metadata = {
  // Título neutro: quien no es admin ve la 404 y la pestaña no debe delatar el panel.
  title: 'AsePsico',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function WaitlistPanelLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
