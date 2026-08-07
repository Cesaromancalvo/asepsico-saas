'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logout } from '../lib/api';

type SidebarProps = {
  syncText?: string;
};

const navigation = [
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
    href: '/settings/data',
    label: 'Datos y piloto',
    icon: '⇩',
  },
];

export default function Sidebar({
  syncText = 'Conectado con AsePsico',
}: SidebarProps) {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === '/') {
      return pathname === '/';
    }

    return pathname.startsWith(href);
  }

  async function handleLogout() {
    try {
      await logout();
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
          <span>Consulta Demo</span>
        </div>
      </Link>

      <nav className="sidebar-nav">
        {navigation.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`sidebar-link ${
              isActive(item.href) ? 'active' : ''
            }`}
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
          <div className="profile-avatar">CR</div>

          <div>
            <strong>César Román</strong>
            <small>Profesional</small>
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
