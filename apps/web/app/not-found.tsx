import Link from 'next/link';
import Icon from '@/components/Icon';
import LegacyRedirect from '@/components/LegacyRedirect';

export const metadata = { title: 'Página no encontrada · AsePsico', robots: { index: false, follow: false } };

/**
 * 404 propia de la aplicación (sustituye a la de Next, en inglés). Neutra a propósito: la usan
 * también las rutas que la API esconde con 404 (p. ej. /admin/lista-espera para quien no es
 * PLATFORM_ADMIN), así que no da pistas de si la página existe para otras personas.
 * En el sitio estático, LegacyRedirect lleva antes las URLs antiguas a las rutas nuevas.
 */
export default function NotFound() {
  return (
    <LegacyRedirect>
      <main className="nf-page">
        <section className="dashboard-card nf-card" aria-labelledby="nf-title">
          <span className="ui-empty-icon" aria-hidden="true"><Icon name="info" size={24} /></span>
          <p className="eyebrow">Error 404</p>
          <h1 id="nf-title">No encontramos esta página</h1>
          <p>Puede que el enlace esté mal escrito o que la página ya no exista.</p>
          <div className="nf-actions">
            <Link href="/" className="button">Ir a Mi jornada</Link>
            <Link href="/login" className="button secondary">Iniciar sesión</Link>
          </div>
        </section>
      </main>
    </LegacyRedirect>
  );
}
