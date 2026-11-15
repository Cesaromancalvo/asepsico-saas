import './globals.css';
import './design-system.css';
import './exceptional-access.css';
import './portal-signup.css';
import './platform-waitlist.css';
import './staff-notifications.css';
import DemoBanner from '@/components/DemoBanner';

export const metadata = {
  title: 'AsePsico',
  description: 'Estamos construyendo AsePsico, un software para psicólogos y consultas de psicología.',
  // referrer: además de la cabecera Referrer-Policy de Render (defensa en profundidad: el id va en la query).
  referrer: 'no-referrer' as const,
  // Segunda capa además de X-Robots-Tag de Render: la app no se indexa; la web pública es asepsico.es.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>
        {/* Aviso fijo del piloto demo: en todas las pantallas, antes del contenido. */}
        <DemoBanner />
        {children}
      </body>
    </html>
  );
}
