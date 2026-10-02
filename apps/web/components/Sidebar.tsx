'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logout } from '../lib/api';
import { invalidateViewer, isAdminRole, isStaffWithProcessAccess, ROLE_LABEL, useViewer } from '../lib/clinical';
type SidebarProps = {
  syncText?: string;
};
// adminOnly: solo OWNER/ADMIN. processAccess: roles que entran en procesos y mensajes (no ASSISTANT).
const navigation: { href: string; label: string; icon: string; adminOnly?: boolean; processAccess?: boolean }[] = [
  {
    href: '/',
    label: 'Mi jornada',
    icon: '⌂',
  },
  {
    href: '/patients',
    label: 'Pacientes',
    icon: '◉',
  },
  {
    href: '/follow-up',
    label: 'Seguimiento',
    icon: '↗',
  },
  {
    href: '/agenda',
    label: 'Agenda',
    icon: '▣',
  },
  {
    href: '/messages',
    label: 'Mensajes',
    icon: '✉',
    processAccess: true,
  },
  {
    href: '/library',
    label: 'Biblioteca',
    icon: '✦',
  },
  {
    href: '/notifications',
    label: 'Avisos',
    icon: '◌',
  },
  {
    href: '/management',
    label: 'Gestión',
    icon: '€',
  },
  {
    href: '/settings/team',
    label: 'Equipo',
    icon: '☷',
    adminOnly: true,
  },
  {
    href: '/settings/security',
    label: 'Seguridad',
    icon: '⛨',
  },
  {
    href: '/settings/data',
    label: 'Datos y piloto',
    icon: '⇩',
  },
];
export default function Sidebar({
  syncText = 'Conectado con AsePsico',
}: SidebarProps) {
  const pathname = usePathname();
  const viewer = useViewer();
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
    } finally {
      window.location.href = '/login';
    }
  }
  return (
    <aside className="sidebar">
      <Link href="/" className="sidebar-brand">
        <div className="brand-mark">A</div>
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
            <span aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
      <div className="sidebar-bottom">
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
          <span aria-hidden="true">↪</span>
          <span>Cerrar sesión</span>
        </button>
      </div>
    </aside>
  );
}
