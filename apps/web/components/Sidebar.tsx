'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logout } from '../lib/api';
import { invalidateViewer, isAdminRole, isStaffWithProcessAccess, ROLE_LABEL, useViewer } from '../lib/clinical';
import { invalidateTermsStatus, useTermsStatus } from '../lib/legal';
import Icon, { IconName } from './Icon';
type SidebarProps = {
  syncText?: string;
};
// adminOnly: solo OWNER/ADMIN. processAccess: roles que entran en procesos y mensajes (no ASSISTANT).
const navigation: { href: string; label: string; icon: IconName; adminOnly?: boolean; processAccess?: boolean }[] = [
  {
    href: '/',
    label: 'Mi jornada',
    icon: 'home',
  },
  {
    href: '/patients',
    label: 'Pacientes',
    icon: 'users',
  },
  {
    href: '/follow-up',
    label: 'Seguimiento',
    icon: 'trend',
  },
  {
    href: '/agenda',
    label: 'Agenda',
    icon: 'calendar',
  },
  {
    href: '/messages',
    label: 'Mensajes',
    icon: 'message',
    processAccess: true,
  },
  {
    href: '/library',
    label: 'Biblioteca',
    icon: 'book',
  },
  {
    href: '/notifications',
    label: 'Avisos',
    icon: 'bell',
  },
  {
    href: '/management',
    label: 'Gestión',
    icon: 'wallet',
  },
  {
    href: '/settings/team',
    label: 'Equipo',
    icon: 'team',
    adminOnly: true,
  },
  {
    href: '/settings/security',
    label: 'Seguridad',
    icon: 'shield',
  },
  {
    href: '/settings/data',
    label: 'Datos y piloto',
    icon: 'database',
  },
];
export default function Sidebar({
  syncText = 'Conectado con AsePsico',
}: SidebarProps) {
  const pathname = usePathname();
  const viewer = useViewer();
  // Condiciones nuevas sin aceptar: cada profesional las acepta por sí mismo y la API le bloquea
  // (428 → /terms) hasta que lo haga. Este aviso es solo un recordatorio por si llega a verse.
  const terms = useTermsStatus();
  const items = navigation.filter((item) =>
    (!item.adminOnly || isAdminRole(viewer?.role)) &&
    (!item.processAccess || isStaffWithProcessAccess(viewer?.role)));
  const displayName = [viewer?.firstName, viewer?.lastName].filter(Boolean).join(' ') || 'Profesional';
  const initials = displayName.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  function isActive(href: string) {
    if (href === '/') {
      return pathname === '/';
    }
    return pathname.startsWith(href);
  }
  async function handleLogout() {
    try {
      await logout();
      invalidateViewer();
      invalidateTermsStatus();
    } finally {
      window.location.href = '/login';
    }
  }
  return (
    <aside className="sidebar">
      <Link href="/" className="sidebar-brand">
        <div className="brand-mark" aria-hidden="true">A</div>
        <div>
          <strong>AsePsico</strong>
          <span>{viewer?.workspaceName || 'Tu consulta'}</span>
        </div>
      </Link>
      <nav className="sidebar-nav">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`sidebar-link ${
              isActive(item.href) ? 'active' : ''
            }`}
            aria-current={isActive(item.href) ? 'page' : undefined}
          >
            <span className="sidebar-icon"><Icon name={item.icon} /></span>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
      <div className="sidebar-bottom">
        {terms?.acceptanceRequired && (
          <p className="sidebar-terms-notice" role="note">
            Tienes condiciones nuevas pendientes de aceptar. <Link href="/terms">Revisar y aceptar</Link>
          </p>
        )}
        <div className="sync-status">
          <span className="sync-dot" />
          <div>
            <strong>Todo sincronizado</strong>
            <small>{syncText}</small>
          </div>
        </div>
        <div className="sidebar-profile">
          <div className="profile-avatar" aria-hidden="true">{initials}</div>
          <div>
            <strong>{displayName}</strong>
            <small>{viewer?.role ? ROLE_LABEL[viewer.role] : 'Profesional'}</small>
          </div>
        </div>
        <button
          type="button"
          className="sidebar-link sidebar-logout"
          onClick={handleLogout}
        >
          <span className="sidebar-icon"><Icon name="logout" /></span>
          <span>Cerrar sesión</span>
        </button>
      </div>
    </aside>
  );
}
