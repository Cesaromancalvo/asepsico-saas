import './globals.css';
import './design-system.css';
import './exceptional-access.css';
import './portal-signup.css';
import DemoBanner from '@/components/DemoBanner';

// referrer: además de la cabecera Referrer-Policy de Render (defensa en profundidad: el id va en la query).
export const metadata = { title: 'AsePsico', description: 'Sistema operativo para la práctica psicológica', referrer: 'no-referrer' as const };

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
