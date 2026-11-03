'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon, { EmptyState } from './Icon';
import {
  badgeText,
  CHANGE_LABEL,
  changeTone,
  fetchUnreadCount,
  isUnread,
  listStaffNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  noticeBody,
  noticeTarget,
  openNotice,
  relativeTime,
  STAFF_NOTIFICATIONS_EVENT,
  StaffNotification,
  unreadLabel,
} from '../lib/staff-notifications';

/*
 * Campana de avisos del personal. Vive en la barra lateral (escritorio y tableta) y en una barra
 * superior propia en el móvil, donde la barra lateral pasa a ser la barra inferior y no cabe.
 * El desplegable se pinta en document.body para que no lo recorte la barra lateral.
 *
 * - Contador: GET /notifications/unread-count al entrar en cada pantalla, cada minuto y cuando otra
 *   parte de la app marca avisos como leídos (STAFF_NOTIFICATIONS_EVENT).
 * - Lista: los últimos avisos (leídos y sin leer) al abrir el desplegable.
 * - Nada en la URL ni en el almacenamiento del navegador.
 */

const VISIBLE = 8;
type ListState = { state: 'idle' | 'loading' | 'ready' | 'error'; items: StaffNotification[] };

export type BellState = ReturnType<typeof useNotificationBell>;

export function useNotificationBell(enabled: boolean, pathname: string) {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ListState>({ state: 'idle', items: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const openerRef = useRef<HTMLElement | null>(null);

  const refreshCount = useCallback(() => {
    fetchUnreadCount().then(setCount).catch(() => undefined);
  }, []);

  const loadList = useCallback(async () => {
    setList((current) => ({ state: current.items.length ? current.state : 'loading', items: current.items }));
    try {
      const items = await listStaffNotifications();
      setList({ state: 'ready', items });
      // Con la lista completa (menos de 100) el contador se puede recalcular sin otra petición.
      if (items.length < 100) setCount(items.filter(isUnread).length);
    } catch {
      setList((current) => ({ state: current.items.length ? 'ready' : 'error', items: current.items }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refreshCount();
    const timer = window.setInterval(refreshCount, 60_000);
    window.addEventListener(STAFF_NOTIFICATIONS_EVENT, refreshCount);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(STAFF_NOTIFICATIONS_EVENT, refreshCount);
    };
  }, [enabled, pathname, refreshCount]);

  // Al cambiar de pantalla, el desplegable se cierra.
  useEffect(() => { setOpen(false); }, [pathname]);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    setError('');
    if (returnFocus) openerRef.current?.focus();
  }, []);

  const toggle = useCallback((opener: HTMLElement) => {
    if (open) { close(); return; }
    openerRef.current = opener;
    setOpen(true);
    void loadList();
  }, [open, close, loadList]);

  const markAll = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await markAllNotificationsRead();
      const readAt = new Date().toISOString();
      setList((current) => ({ ...current, items: current.items.map((n) => (isUnread(n) ? { ...n, readAt, status: 'READ' } : n)) }));
      setCount(0);
    } catch {
      setError('No se han podido marcar como leídos. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }, []);

  const markOne = useCallback(async (n: StaffNotification) => {
    setError('');
    try {
      await markNotificationRead(n.id);
      setList((current) => ({ ...current, items: current.items.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString(), status: 'READ' } : x)) }));
      setCount((c) => Math.max(0, c - 1));
    } catch {
      setError('No se ha podido marcar como leído. Inténtalo de nuevo.');
    }
  }, []);

  return { count, open, list, busy, error, toggle, close, loadList, markAll, markOne, openerRef };
}

export function BellButton({ bell, placement, controlsId }: { bell: BellState; placement: 'sidebar' | 'topbar'; controlsId: string }) {
  const label = `Avisos. ${unreadLabel(bell.count)}`;
  return (
    <button
      type="button"
      className={`bell-button bell-${placement}${bell.count > 0 ? ' has-unread' : ''}`}
      aria-label={label}
      title={unreadLabel(bell.count)}
      aria-haspopup="dialog"
      aria-expanded={bell.open}
      aria-controls={bell.open ? controlsId : undefined}
      onClick={(event) => bell.toggle(event.currentTarget)}
    >
      <Icon name="bell" size={20} />
      {bell.count > 0 && <span className="bell-badge" aria-hidden="true">{badgeText(bell.count)}</span>}
    </button>
  );
}

export function NotificationPanel({ bell, id }: { bell: BellState; id: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted || !bell.open) return null;
  return createPortal(<PanelContent bell={bell} id={id} />, document.body);
}

/** Contenido del desplegable (exportado para los tests de componente; la app usa NotificationPanel). */
export function PanelContent({ bell, id }: { bell: BellState; id: string }) {
  const router = useRouter();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { close } = bell;

  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if ((target as Element).closest?.('.bell-button')) return; // el propio botón alterna
      close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [close]);

  const items = bell.list.items.slice(0, VISIBLE);
  const unreadInList = bell.list.items.some(isUnread);

  async function activate(n: StaffNotification) {
    close(false);
    await openNotice(n, (href) => router.push(href));
  }

  return (
    <div ref={panelRef} id={id} className="bell-panel" role="dialog" aria-modal="false" aria-labelledby={titleId}>
      <div className="bell-panel-header">
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>Avisos</h2>
        <button
          type="button"
          className="text-link bell-mark-all"
          onClick={() => void bell.markAll()}
          disabled={bell.busy || (bell.count === 0 && !unreadInList)}
        >
          {bell.busy ? 'Marcando…' : 'Marcar todos como leídos'}
        </button>
        <button type="button" className="bell-close" onClick={() => close()} aria-label="Cerrar avisos">
          <Icon name="close" size={18} />
        </button>
      </div>
      {bell.error && <p className="bell-error" role="alert">{bell.error}</p>}
      <div className="bell-panel-body">
        {bell.list.state === 'loading' && <p className="bell-state" role="status">Cargando avisos…</p>}
        {bell.list.state === 'error' && (
          <div className="bell-state" role="alert">
            <strong>No se han podido cargar los avisos</strong>
            <p>Comprueba tu conexión y vuelve a intentarlo.</p>
            <button type="button" className="small-secondary" onClick={() => void bell.loadList()}>Reintentar</button>
          </div>
        )}
        {bell.list.state === 'ready' && items.length === 0 && (
          <EmptyState icon="bell" title="No tienes avisos" compact>Aquí verás los cambios en tus citas y otros avisos de la consulta.</EmptyState>
        )}
        {items.length > 0 && (
          <ul className="bell-list">
            {items.map((n) => {
              const target = noticeTarget(n);
              const unread = isUnread(n);
              const change = n.appointmentChange;
              const content = (
                <>
                  <span className={`bell-dot${unread ? ' is-unread' : ''}`} aria-hidden="true" />
                  <span className="bell-item-copy">
                    {change ? <span className={`ui-chip ${changeTone(change.change)}`}>{CHANGE_LABEL[change.change]}</span> : <strong>{n.title}</strong>}
                    <span className="bell-item-body">{noticeBody(n)}</span>
                    <small>
                      {unread && <span className="sr-only">Sin leer. </span>}
                      {relativeTime(n.createdAt)}
                      {target && <span className="bell-item-action"> · {target.label}<Icon name="chevronRight" size={14} /></span>}
                    </small>
                  </span>
                </>
              );
              return (
                <li key={n.id} className={`bell-item${unread ? ' is-unread' : ''}`}>
                  {target ? (
                    <button type="button" className="bell-item-main" onClick={() => void activate(n)}>{content}</button>
                  ) : (
                    <div className="bell-item-main is-static">{content}</div>
                  )}
                  {!target && unread && (
                    <button type="button" className="small-secondary bell-item-read" onClick={() => void bell.markOne(n)}>
                      Marcar como leído
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="bell-panel-footer">
        <Link href="/notifications" className="text-link" onClick={() => close(false)}>Ver todos los avisos</Link>
      </div>
    </div>
  );
}
