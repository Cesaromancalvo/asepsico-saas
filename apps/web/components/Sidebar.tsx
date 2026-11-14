'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { logout, SESSION_EXPIRED_EVENT } from '../lib/api';
import { currentPath, loginHref } from '../lib/login-redirect';
import { pendingLabel, PENDING_REQUESTS_EVENT } from '../lib/booking';
import { fetchPendingCount } from '../lib/booking-client';
import { invalidateViewer, isAdminRole, isStaffWithProcessAccess, ROLE_LABEL, useViewer } from '../lib/clinical';
import { invalidateTermsStatus, useTermsStatus } from '../lib/legal';
import { invalidatePlatformAdmin, PANEL_PATH, usePlatformAdmin } from '../lib/platform-waitlist';
import Icon, { IconName } from './Icon';
import { BellButton, NotificationPanel, useNotificationBell } from './NotificationBell';
type SidebarProps = {
  syncText?: string;
};
// adminOnly: solo OWNER/ADMIN. processAccess: roles que entran en procesos y mensajes (no ASSISTANT).
// noAssistant: recepción no lo gestiona (el QR de alta es de cada profesional).
const navigation: { href: string; label: string; icon: IconName; adminOnly?: boolean; processAccess?: boolean; noAssistant?: boolean; pendingBadge?: boolean }[] = [
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
    href: '/agenda/solicitudes',
    label: 'Solicitudes',
    icon: 'inbox',
    pendingBadge: true,
  },
  {
    href: '/portal-signups',
    label: 'Altas del portal',
    icon: 'userPlus',
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
    href: '/settings/portal-qr',
    label: 'QR de alta',
    icon: 'qr',
    noAssistant: true,
  },
  {
    // «Mi cuenta»: seguridad (contraseña, verificación en dos pasos) y avisos por email.
    // El pie de los emails al equipo remite a «Mi cuenta».
    href: '/settings/security',
    label: 'Mi cuenta',
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
  // Panel de la lista de espera: el enlace solo existe si la API dice platformAdmin (nadie más lo ve).
  const platformAdmin = usePlatformAdmin();
  // Solicitudes de cita pendientes (solo el número, sin nombres ni fechas). Se vuelve a pedir al
  // cambiar de pantalla, cada minuto y cuando la bandeja avisa de que resolvió alguna.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (!viewer?.role) return;
    let cancelled = false;
    const refresh = () => {
      fetchPendingCount().then((count) => { if (!cancelled) setPending(count); }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener(PENDING_REQUESTS_EVENT, refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(PENDING_REQUESTS_EVENT, refresh);
    };
  }, [viewer?.role, pathname]);
  // Sesión caducada al guardar (o en un refresco de fondo): no se navega para no perder lo escrito;
  // se avisa con un enlace al login en otra pestaña. Tras entrar, se vuelve aquí y se guarda.
  const [sessionExpired, setSessionExpired] = useState(false);
  const [loginLink, setLoginLink] = useState('/login');
  useEffect(() => {
    const onExpired = () => {
      setLoginLink(loginHref(currentPath()));
      setSessionExpired(true);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);
  // Campana de avisos (cambios de cita y demás avisos propios). Mismo estado para los dos botones
  // (barra lateral y barra superior del móvil) y un solo desplegable.
  const bell = useNotificationBell(Boolean(viewer?.role), pathname);
  const bellPanelId = 'avisos-desplegable';
  const items = navigation.filter((item) =>
    (!item.adminOnly || isAdminRole(viewer?.role)) &&
    (!item.processAccess || isStaffWithProcessAccess(viewer?.role)) &&
    (!item.noAssistant || (viewer?.role != null && viewer.role !== 'ASSISTANT')));
  const displayName = [viewer?.firstName, viewer?.lastName].filter(Boolean).join(' ') || 'Profesional';
  const initials = displayName.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  function isActive(href: string) {
    if (href === '/') {
      return pathname === '/';
    }
    // La bandeja de solicitudes cuelga de /agenda pero tiene su propia entrada.
    if (href === '/agenda') {
      return pathname === '/agenda' || (pathname.startsWith('/agenda/') && !pathname.startsWith('/agenda/solicitudes'));
    }
    if (href === '/settings/security') {
      return pathname.startsWith(href) || pathname.startsWith('/settings/email-notifications');
    }
    return pathname.startsWith(href);
  }
  async function handleLogout() {
    try {
      await logout();
      invalidateViewer();
      invalidateTermsStatus();
      invalidatePlatformAdmin();
    } finally {
      window.location.href = '/login';
    }
  }
  return (
    <>
    <aside className="sidebar">
      <div className="sidebar-top">
        <Link href="/" className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">A</div>
          <div>
            <strong>AsePsico</strong>
            <span>{viewer?.workspaceName || 'Tu consulta'}</span>
          </div>
        </Link>
        {viewer?.role && <BellButton bell={bell} placement="sidebar" controlsId={bellPanelId} />}
      </div>
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
            {item.pendingBadge && pending > 0 && (
              <span className="sidebar-badge" role="status" aria-label={pendingLabel(pending)}>{pending > 99 ? '99+' : pending}</span>
            )}
          </Link>
        ))}
      </nav>
      {platformAdmin && (
        <nav className="sidebar-nav sidebar-admin" aria-label="Administración de AsePsico">
          <span className="sidebar-section-label">Administración</span>
          <Link
            href={PANEL_PATH}
            className={`sidebar-link ${pathname.startsWith(PANEL_PATH) ? 'active' : ''}`}
            aria-current={pathname.startsWith(PANEL_PATH) ? 'page' : undefined}
          >
            <span className="sidebar-icon"><Icon name="clipboard" /></span>
            <span>Lista de espera</span>
          </Link>
        </nav>
      )}
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
    {/* Móvil: la barra lateral es la barra inferior; marca y campana van en esta barra superior. */}
    <div className="mobile-topbar">
      <Link href="/" className="mobile-topbar-brand">
        <span className="brand-mark" aria-hidden="true">A</span>
        <span>{viewer?.workspaceName || 'AsePsico'}</span>
      </Link>
      {viewer?.role && <BellButton bell={bell} placement="topbar" controlsId={bellPanelId} />}
    </div>
    <NotificationPanel bell={bell} id={bellPanelId} />
    {sessionExpired && (
      <div className="session-expired-banner" role="alert">
        <p>
          <strong>Tu sesión ha caducado.</strong> Lo que has escrito sigue en esta pantalla: inicia sesión en otra pestaña y vuelve aquí para guardar.
        </p>
        <div className="session-expired-actions">
          <a className="primary-action" href={loginLink} target="_blank" rel="noopener noreferrer">Iniciar sesión<span className="sr-only"> (se abre en otra pestaña)</span></a>
          <button type="button" className="search-action" onClick={() => setSessionExpired(false)}>Ya he entrado</button>
        </div>
      </div>
    )}
    </>
  );
}
