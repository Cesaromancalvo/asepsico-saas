import Link from 'next/link';

/** Se muestra cuando se llega a /register o /join sin un enlace de invitación completo. */
export default function InviteOnlyCard({ title = 'Alta solo por invitación' }: { title?: string }) {
  return (
    <main className="shell">
      <div className="card auth-card">
        <div className="brand"><span className="brand-mark" aria-hidden="true">A</span>AsePsico</div>
        <h1>{title}</h1>
        <p className="muted">
          Por ahora el acceso a AsePsico es solo por invitación. Si te han invitado, abre el enlace completo que te
          enviaron (sin recortarlo). Si ha caducado, pide uno nuevo a quien te invitó.
        </p>
        <Link href="/login" className="button secondary">Ir a iniciar sesión</Link>
      </div>
    </main>
  );
}
