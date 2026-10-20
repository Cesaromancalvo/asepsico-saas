'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PortalIntakeLinkContract, SchedulingProfessionalContract } from '@asepsico/contracts';
import Sidebar from '@/components/Sidebar';
import Icon, { EmptyState } from '@/components/Icon';
import QrCode from '@/components/QrCode';
import { ApiError } from '@/lib/api';
import { listProfessionals } from '@/lib/booking-client';
import { isAdminRole, useViewer } from '@/lib/clinical';
import { disableIntakeLink, formatDateTime, getIntakeLink, intakeUrl, rotateIntakeLink } from '@/lib/portal-signup';
import { qrSvgDocument } from '@/lib/qr';

type State = 'loading' | 'ready' | 'not-clinical' | 'forbidden' | 'error';
type Confirm = 'rotate' | 'disable' | null;

/**
 * QR fijo de alta en el portal. Cada profesional imprime el suyo y lo deja en la consulta; quien lo
 * escanea envía una solicitud que la consulta revisa en «Altas del portal». Gestionan el QR el
 * propio profesional y, para cualquier profesional, titular y administración. Recepción no.
 */
export default function PortalQrPage() {
  const viewer = useViewer();
  const [professionals, setProfessionals] = useState<SchedulingProfessionalContract[]>([]);
  const [professionalId, setProfessionalId] = useState<string | null>(null);
  const [link, setLink] = useState<PortalIntakeLinkContract | null>(null);
  const [state, setState] = useState<State>('loading');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [copyState, setCopyState] = useState('');
  const [origin, setOrigin] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);

  const isAdmin = isAdminRole(viewer?.role);

  useEffect(() => setOrigin(window.location.origin), []);

  // Profesional cuyo QR se muestra: el propio si atiende pacientes; si no (titular o administración
  // que no atiende), el primero de la lista.
  useEffect(() => {
    if (!viewer) return;
    if (viewer.role === 'ASSISTANT') { setState('forbidden'); return; }
    if (!isAdmin) { setProfessionalId('me'); return; }
    listProfessionals()
      .then((data) => {
        setProfessionals(data.professionals);
        const own = data.professionals.find((p) => p.id === viewer.userId);
        setProfessionalId(own ? own.id : data.professionals[0]?.id ?? '');
        if (!data.professionals.length) setState('not-clinical');
      })
      .catch(() => { setError('No se ha podido cargar la lista de profesionales.'); setState('error'); });
  }, [viewer, isAdmin]);

  const load = useCallback(async (id: string) => {
    setState('loading'); setError(''); setConfirm(null); setCopyState('');
    try {
      setLink(await getIntakeLink(id));
      setState('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) { setState('not-clinical'); return; }
      if (err instanceof ApiError && err.status === 403) { setState('forbidden'); return; }
      setError(err instanceof Error && err.message ? err.message : 'No se ha podido cargar el QR.');
      setState('error');
    }
  }, []);

  useEffect(() => { if (professionalId) void load(professionalId); }, [professionalId, load]);

  async function rotate(successMessage: string) {
    if (!professionalId) return;
    setBusy(true); setError(''); setStatus(''); setConfirm(null);
    try {
      setLink(await rotateIntakeLink(professionalId));
      setStatus(successMessage);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'No se ha podido generar el QR.');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!professionalId) return;
    setBusy(true); setError(''); setStatus(''); setConfirm(null);
    try {
      await disableIntakeLink(professionalId);
      setLink((current) => (current ? { ...current, isActive: false, token: null } : current));
      setStatus('QR desactivado. Escanearlo ya no crea solicitudes; las que ya tienes siguen en «Altas del portal».');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'No se ha podido desactivar el QR.');
    } finally {
      setBusy(false);
    }
  }

  const url = link?.token && origin ? intakeUrl(origin, link.token) : '';

  function download() {
    if (!url) return;
    const blob = new Blob([qrSvgDocument(url, 'QR de alta en el portal del paciente')], { type: 'image/svg+xml' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = 'qr-alta-portal.svg';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('Enlace copiado.');
    } catch {
      urlRef.current?.select();
      setCopyState('No se ha podido copiar: el enlace está seleccionado, cópialo con Ctrl+C o Cmd+C.');
    }
  }

  const selectedName = professionals.find((p) => p.id === professionalId)?.name;
  const isOwn = professionalId === 'me' || professionalId === viewer?.userId;

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="patient-record-page">
        <header className="patient-record-header">
          <div>
            <span className="eyebrow">Portal del paciente</span>
            <h1>{isAdmin ? 'QR de alta' : 'Mi QR de alta'}</h1>
            <p className="dashboard-subtitle">
              Imprímelo y déjalo en tu consulta. Quien lo escanee podrá pedir su acceso al portal; nadie entra hasta que lo revises en{' '}
              <Link href="/portal-signups">Altas del portal</Link> y le entregues la activación en persona.
            </p>
          </div>
        </header>

        {error && <div className="agenda-error" role="alert">{error}</div>}
        <p className={status ? 'patient-save-state' : 'bk-live'} role="status" aria-live="polite">{status}</p>

        {isAdmin && professionals.length > 0 && (
          <div className="ps-toolbar">
            <label className="ps-filter">
              <span>QR de</span>
              <select value={professionalId ?? ''} disabled={busy} onChange={(event) => { setStatus(''); setProfessionalId(event.target.value); }}>
                {professionals.map((p) => <option key={p.id} value={p.id}>{p.id === viewer?.userId ? `${p.name} (tú)` : p.name}</option>)}
              </select>
            </label>
          </div>
        )}

        {state === 'loading' && <div className="patient-record-loading" role="status">Cargando QR…</div>}

        {state === 'forbidden' && (
          <section className="patient-record-card">
            <EmptyState icon="lock" title="El QR lo gestiona cada profesional">
              Recepción no imprime ni cambia los QR de alta, pero sí revisa las solicitudes en «Altas del portal».
            </EmptyState>
          </section>
        )}

        {state === 'not-clinical' && (
          <section className="patient-record-card">
            <EmptyState icon="qr" title={isAdmin ? 'No hay profesionales que atiendan pacientes' : 'Tu perfil no atiende pacientes'}>
              El QR de alta es de cada profesional que atiende pacientes. {isAdmin ? 'Márcalo en Ajustes > Equipo.' : 'Si debería, pídeselo a la persona titular.'}
            </EmptyState>
          </section>
        )}

        {state === 'error' && (
          <section className="patient-record-card" role="alert">
            <p>No se ha podido cargar el QR.</p>
            {professionalId && <button type="button" className="button secondary" onClick={() => void load(professionalId)}>Intentar de nuevo</button>}
          </section>
        )}

        {state === 'ready' && link && (
          <section className="patient-record-card ps-qr-card" aria-labelledby="qr-title">
            <div className="ps-qr-head">
              <div>
                <h2 id="qr-title">{isOwn ? 'Tu QR' : `QR de ${selectedName ?? 'este profesional'}`}</h2>
                <p className="muted">
                  {link.isActive && link.rotatedAt && `Generado el ${formatDateTime(link.rotatedAt)}.`}
                  {!link.isActive && link.exists !== false && 'Está desactivado: escanearlo no crea solicitudes.'}
                  {link.exists === false && 'Todavía no tiene QR de alta.'}
                </p>
              </div>
              <span className={`ui-chip ${link.isActive ? 'chip-green' : 'chip-neutral'}`}>{link.isActive ? 'Activo' : link.exists === false ? 'Sin crear' : 'Desactivado'}</span>
            </div>

            {link.isActive && url ? (
              <div className="ps-qr-body">
                <div className="ps-print-area">
                  <div className="ps-poster">
                    <p className="ps-poster-kicker">Portal del paciente</p>
                    <QrCode value={url} label="Código QR de alta en el portal" size={232} className="ps-qr-svg" />
                    <p className="ps-poster-title">Escanéalo con la cámara de tu móvil</p>
                    <p className="ps-poster-text">para pedir tu acceso al portal. Tu consulta lo revisará contigo.</p>
                  </div>
                </div>
                <div className="ps-qr-actions">
                  <div className="ps-action-group">
                    <button type="button" className="button" onClick={() => window.print()}><Icon name="file" size={18} />Imprimir</button>
                    <button type="button" className="button secondary" onClick={download}>Descargar (SVG)</button>
                  </div>
                  <div className="ps-url-row">
                    <label htmlFor="intake-url" className="ps-label">Enlace del QR</label>
                    <div className="ps-search-row">
                      <input id="intake-url" ref={urlRef} readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
                      <button type="button" className="button secondary" onClick={copy}>Copiar</button>
                    </div>
                    <small className="muted" role="status" aria-live="polite">{copyState || 'Sirve para ponerlo en la web de tu consulta. Quien lo use solo puede pedir acceso.'}</small>
                  </div>

                  <div className="ps-danger-zone">
                    <h3>Si el QR se ha difundido donde no debía</h3>
                    {confirm === 'rotate' ? (
                      <div className="bk-inline-confirm" role="group" aria-label="Confirmar el cambio de QR">
                        <span>El QR impreso dejará de funcionar y tendrás que imprimir el nuevo.</span>
                        <button type="button" className="button" disabled={busy} onClick={() => void rotate('QR cambiado. Imprime el nuevo: el anterior ya no funciona.')}>Sí, cambiar el QR</button>
                        <button type="button" className="bk-link-button" onClick={() => setConfirm(null)}>Volver</button>
                      </div>
                    ) : confirm === 'disable' ? (
                      <div className="bk-inline-confirm" role="group" aria-label="Confirmar la desactivación del QR">
                        <span>Escanearlo dejará de crear solicitudes. Las que ya tienes siguen en la bandeja.</span>
                        <button type="button" className="button danger" disabled={busy} onClick={() => void disable()}>Sí, desactivar</button>
                        <button type="button" className="bk-link-button" onClick={() => setConfirm(null)}>Volver</button>
                      </div>
                    ) : (
                      <div className="ps-action-group">
                        <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirm('rotate')}>Cambiar por uno nuevo</button>
                        <button type="button" className="bk-link-button ps-reject" disabled={busy} onClick={() => setConfirm('disable')}>Desactivar</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="ps-qr-empty">
                <p>
                  {link.exists === false
                    ? 'Crea el QR, imprímelo y déjalo a la vista en la consulta.'
                    : 'Al activarlo se genera un QR nuevo. El que tenías impreso no vuelve a funcionar.'}
                </p>
                <button type="button" className="button" disabled={busy} onClick={() => void rotate(link.exists === false ? 'QR creado. Ya puedes imprimirlo.' : 'QR activado. Imprime el nuevo.')}>
                  {busy ? 'Generando…' : link.exists === false ? 'Crear el QR' : 'Activar con un QR nuevo'}
                </button>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
