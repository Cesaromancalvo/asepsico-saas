'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import ReasonDialog from '@/components/ReasonDialog';
import { api } from '@/lib/api';
import { CLINICAL_TEXT_HINT, chargeStatusLabel, freeText, lineLabel } from '@/lib/billing';
import { INVOICE_LINE_CONCEPTS, type BillingFreeTextFlagsContract, type InvoiceLineConcept, type InvoiceListItemContract } from '@asepsico/contracts';

type Patient = { id: string; firstName: string; lastName: string };
type Payment = { id: string; amountCents: number; method: string; paidAt: string; reversedAt?: string | null };
// GET /billing/invoices: resumen sin líneas ni notas. `concept` es el de la primera línea (lista cerrada).
type Invoice = Pick<InvoiceListItemContract, 'id' | 'invoiceNumber' | 'status' | 'totalCents' | 'paidCents' | 'dueDate' | 'concept' | 'patient'> & { payments: Payment[] };
// GET /billing/invoices/:id: detalle con líneas. Un texto libre antiguo fuera del catálogo llega a
// recepción como legacyDescriptionHidden: se muestra "Otro concepto" y nada más.
type InvoiceLine = { id: string; description: string; quantity: number; unitPriceCents: number; legacyDescriptionHidden?: true };
// Textos libres (notas, motivo, referencia): a recepción le llegan a null con <campo>Hidden: true.
type DetailPayment = Pick<BillingFreeTextFlagsContract, 'notesHidden' | 'referenceHidden' | 'reversalReasonHidden'> & {
  id: string; amountCents: number; method: string; paidAt: string; reversedAt?: string | null;
  notes?: string | null; reference?: string | null; reversalReason?: string | null;
};
type InvoiceDetail = Pick<BillingFreeTextFlagsContract, 'notesHidden' | 'voidReasonHidden'> & {
  id: string; status: string; lines: InvoiceLine[]; payments?: DetailPayment[]; notes?: string | null; voidReason?: string | null;
};
type DetailState = { id: string; state: 'loading' | 'ready' | 'error'; invoice: InvoiceDetail | null };

const methodLabels: Record<string, string> = { CASH: 'Efectivo', CARD: 'Tarjeta', BANK_TRANSFER: 'Transferencia', BIZUM: 'Bizum', DIRECT_DEBIT: 'Domiciliación', OTHER: 'Otro' };

function FreeTextRow({ label, value }: { label: string; value: { text: string; hidden: boolean } | null }) {
  if (!value) return null;
  return <li><span>{label}</span><span className={value.hidden ? 'billing-hidden' : undefined}>{value.text}</span></li>;
}
type Summary = { invoicedCents: number; collectedCents: number; outstandingCents: number; overdueCount: number };

const money = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);
// Motivo pedido en el diálogo: anular un cobro o revertir uno de sus pagos.
type ReasonTarget = { kind: 'void'; invoice: Invoice } | { kind: 'reverse'; invoice: Invoice; payment: DetailPayment };

export default function ManagementPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [summary, setSummary] = useState<Summary>({ invoicedCents:0, collectedCents:0, outstandingCents:0, overdueCount:0 });
  const [patientId, setPatientId] = useState('');
  const [description, setDescription] = useState<InvoiceLineConcept>('Sesión de psicología');
  const [notes, setNotes] = useState('');
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [amount, setAmount] = useState('60');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [reasonTarget, setReasonTarget] = useState<ReasonTarget | null>(null);

  async function load() {
    const [patientResponse, invoiceResponse, summaryResponse] = await Promise.all([
      api<{ data: Patient[] }>('/patients?status=ACTIVE&pageSize=100'),
      api<Invoice[]>('/billing/invoices'),
      api<Summary>('/billing/summary'),
    ]);
    setPatients(patientResponse.data); setInvoices(invoiceResponse); setSummary(summaryResponse);
    if (!patientId && patientResponse.data[0]) setPatientId(patientResponse.data[0].id);
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const selected = useMemo(() => patients.find((p) => p.id === patientId), [patients, patientId]);

  async function createInvoice(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const unitPriceCents = Math.round(Number(amount.replace(',', '.')) * 100);
      if (!patientId || !description || !Number.isFinite(unitPriceCents) || unitPriceCents <= 0) throw new Error('Revisa los datos del cobro');
      await api('/billing/invoices', { method:'POST', body: JSON.stringify({ patientId, dueDate: dueDate || undefined, notes: notes.trim() || undefined, lines:[{ description, quantity:1, unitPriceCents, taxRateBps:0 }] }) });
      setNotes('');
      setMessage('Cobro guardado como borrador. Confírmalo y después podrás enviarlo al paciente.');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo crear'); } finally { setBusy(false); }
  }

  async function toggleDetail(invoice: Invoice) {
    if (detail?.id === invoice.id) { setDetail(null); return; }
    setDetail({ id: invoice.id, state: 'loading', invoice: null });
    try {
      const data = await api<InvoiceDetail>(`/billing/invoices/${invoice.id}`);
      setDetail((current) => (current?.id === invoice.id ? { id: invoice.id, state: 'ready', invoice: data } : current));
    } catch {
      setDetail((current) => (current?.id === invoice.id ? { id: invoice.id, state: 'error', invoice: null } : current));
    }
  }

  async function action(path: string, body?: object, successMessage='Operación completada') {
    setBusy(true); setError(''); setMessage('');
    try { await api(path, { method:'POST', body: JSON.stringify(body ?? {}) }); setMessage(successMessage); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Operación fallida'); } finally { setBusy(false); }
  }

  /** Confirma el diálogo de motivo. Devuelve el error para enseñarlo dentro del diálogo (no se cierra). */
  async function confirmReason(reason: string): Promise<string | null> {
    if (!reasonTarget) return null;
    const { kind, invoice } = reasonTarget;
    const path = kind === 'void' ? `/billing/invoices/${invoice.id}/void` : `/billing/payments/${reasonTarget.payment.id}/reverse`;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(path, { method:'POST', body: JSON.stringify({ reason }) });
      setMessage(kind === 'void' ? `Cobro ${invoice.invoiceNumber} anulado.` : 'Pago revertido. El importe vuelve a quedar pendiente.');
      if (kind === 'reverse') setDetail(null);
      await load();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'No se pudo guardar. Inténtalo de nuevo.';
    } finally { setBusy(false); }
  }

  async function registerPayment(invoice: Invoice) {
    const pending = invoice.totalCents - invoice.paidCents;
    const raw = window.prompt(`Importe recibido (máximo ${money(pending)}):`, String(pending / 100));
    if (!raw) return;
    const amountCents = Math.round(Number(raw.replace(',', '.')) * 100);
    const method = window.prompt('Método: CASH, CARD, BANK_TRANSFER, BIZUM, DIRECT_DEBIT u OTHER', 'CARD') || 'CARD';
    await action('/billing/payments', { invoiceId: invoice.id, amountCents, method, idempotencyKey: `${invoice.id}-${Date.now()}` });
  }

  return <div className="app-layout"><Sidebar/><main className="patient-record-page">
    <header className="patient-record-header"><div><span className="eyebrow">Gestión económica</span><h1>Control de cobros</h1><p>Registro sencillo de cobros, saldos y pagos de la consulta.</p></div></header>
    {error && <div className="agenda-error" role="alert">{error}</div>}
    {message && <div className="patient-save-state" role="status">{message}</div>}
    <section className="billing-kpis">
      <article><span>Total registrado</span><strong>{money(summary.invoicedCents)}</strong></article>
      <article><span>Cobrado</span><strong>{money(summary.collectedCents)}</strong></article>
      <article><span>Pendiente</span><strong>{money(summary.outstandingCents)}</strong></article>
      <article><span>Vencidos</span><strong>{summary.overdueCount}</strong></article>
    </section>
    <section className="patient-card billing-create"><h2>Nuevo cobro</h2><form onSubmit={createInvoice} className="billing-form">
      <label>Paciente<select value={patientId} onChange={(e)=>setPatientId(e.target.value)}>{patients.map(p=><option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}</select></label>
      <label>Concepto
        <select value={description} onChange={(e)=>setDescription(e.target.value as InvoiceLineConcept)} aria-describedby="invoice-concept-hint">
          {INVOICE_LINE_CONCEPTS.map((concept) => <option key={concept} value={concept}>{concept}</option>)}
        </select>
        <small id="invoice-concept-hint" className="demo-hint">Si ninguno encaja, elige «Otro concepto». El concepto nunca lleva información clínica.</small>
      </label>
      <label>Importe (€)<input inputMode="decimal" value={amount} onChange={(e)=>setAmount(e.target.value)} /></label>
      <label>Vencimiento<input type="date" value={dueDate} onChange={(e)=>setDueDate(e.target.value)} /></label>
      <label className="billing-notes">Notas (opcional)
        <textarea value={notes} maxLength={1000} rows={2} onChange={(e)=>setNotes(e.target.value)} aria-describedby="invoice-notes-hint" />
        <small id="invoice-notes-hint" className="demo-hint">{CLINICAL_TEXT_HINT}</small>
      </label>
      <button className="button primary" disabled={busy || !selected}>Crear borrador</button>
    </form></section>
    <section className="patient-card"><div className="section-heading"><div><span className="eyebrow">Histórico</span><h2>Cobros</h2></div></div>
      <div className="billing-list">{invoices.map(invoice => <article key={invoice.id} className="billing-row">
        <div><strong>{invoice.invoiceNumber}</strong><span>{invoice.patient.firstName} {invoice.patient.lastName}</span>{invoice.concept && <small>{invoice.concept}</small>}</div>
        <div><span className={`status-pill ${invoice.status.toLowerCase()}`}>{chargeStatusLabel(invoice.status)}</span><strong>{money(invoice.totalCents)}</strong><small>Pendiente {money(invoice.totalCents - invoice.paidCents)}</small></div>
        <div className="billing-actions">
          <button type="button" aria-expanded={detail?.id === invoice.id} aria-controls={`invoice-lines-${invoice.id}`} onClick={()=>void toggleDetail(invoice)}>{detail?.id === invoice.id ? 'Ocultar detalle' : 'Ver detalle'}</button>
          {invoice.status === 'DRAFT' && <button disabled={busy} onClick={()=>action(`/billing/invoices/${invoice.id}/issue`, undefined, 'Cobro confirmado. Ya puedes enviarlo al paciente.')}>Confirmar cobro</button>}
          {['ISSUED','PARTIALLY_PAID','OVERDUE','PAID'].includes(invoice.status) && <button disabled={busy} onClick={()=>action(`/billing/invoices/${invoice.id}/send`, undefined, 'Cobro enviado al portal del paciente. Si tiene el correo activado, queda también preparado para envío por email.')}>Enviar al paciente</button>}
          {['ISSUED','PARTIALLY_PAID','OVERDUE'].includes(invoice.status) && <button disabled={busy} onClick={()=>registerPayment(invoice)}>Registrar pago</button>}
          {!['PAID','VOID'].includes(invoice.status) && invoice.paidCents===0 && <button type="button" disabled={busy} aria-haspopup="dialog" onClick={()=>setReasonTarget({ kind: 'void', invoice })}>Anular</button>}
        </div>
        {detail?.id === invoice.id && <div id={`invoice-lines-${invoice.id}`} className="billing-detail">
          {detail.state === 'loading' && <small role="status">Cargando detalle…</small>}
          {detail.state === 'error' && <small role="alert">No se pudo cargar el detalle. Inténtalo de nuevo.</small>}
          {detail.state === 'ready' && detail.invoice && <InvoiceDetailView invoice={detail.invoice} busy={busy} onReverse={(payment)=>setReasonTarget({ kind: 'reverse', invoice, payment })} />}
        </div>}
      </article>)}{!invoices.length && <p>No hay cobros registrados todavía.</p>}</div>
    </section>
    <ReasonDialog
      open={reasonTarget !== null}
      title={reasonTarget?.kind === 'reverse' ? 'Revertir pago' : 'Anular cobro'}
      description={reasonTarget ? (reasonTarget.kind === 'reverse'
        ? `Pago de ${money(reasonTarget.payment.amountCents)} del cobro ${reasonTarget.invoice.invoiceNumber}. El importe volverá a quedar pendiente.`
        : `Cobro ${reasonTarget.invoice.invoiceNumber} de ${reasonTarget.invoice.patient.firstName} ${reasonTarget.invoice.patient.lastName}. No se puede deshacer.`) : undefined}
      label={reasonTarget?.kind === 'reverse' ? 'Motivo de la reversión' : 'Motivo de la anulación'}
      confirmLabel={reasonTarget?.kind === 'reverse' ? 'Revertir pago' : 'Anular cobro'}
      onConfirm={confirmReason}
      onClose={()=>setReasonTarget(null)}
    />
  </main></div>;
}

function InvoiceDetailView({ invoice, busy, onReverse }: { invoice: InvoiceDetail; busy: boolean; onReverse: (payment: DetailPayment) => void }) {
  const lines = invoice.lines ?? [];
  const payments = invoice.payments ?? [];
  const notes = freeText(invoice.notes, invoice.notesHidden);
  const voidReason = invoice.status === 'VOID' || invoice.voidReasonHidden ? freeText(invoice.voidReason, invoice.voidReasonHidden) : null;
  return <>
    {lines.length
      ? <ul aria-label="Conceptos">{lines.map((line) => <li key={line.id}><span>{lineLabel(line)}</span><span>{line.quantity} × {money(line.unitPriceCents)}</span></li>)}</ul>
      : <small>Este cobro no tiene conceptos.</small>}
    {(notes || voidReason) && <ul aria-label="Notas del cobro">
      <FreeTextRow label="Notas" value={notes} />
      <FreeTextRow label="Motivo de anulación" value={voidReason} />
    </ul>}
    {payments.length > 0 && <>
      <strong className="billing-detail-title">Pagos</strong>
      <ul aria-label="Pagos">{payments.map((payment) => {
        const reference = freeText(payment.reference, payment.referenceHidden);
        const paymentNotes = freeText(payment.notes, payment.notesHidden);
        const reversal = payment.reversedAt || payment.reversalReasonHidden ? freeText(payment.reversalReason, payment.reversalReasonHidden) : null;
        return <li key={payment.id} className="billing-payment">
          <span>{new Date(payment.paidAt).toLocaleDateString('es-ES')} · {methodLabels[payment.method] ?? payment.method}{payment.reversedAt ? ' · Revertido' : ''}</span>
          <span>{money(payment.amountCents)}</span>
          {!payment.reversedAt && invoice.status !== 'VOID' && <button type="button" className="billing-reverse" disabled={busy} aria-haspopup="dialog" onClick={()=>onReverse(payment)}>Revertir pago</button>}
          {(reference || paymentNotes || reversal) && <ul>
            <FreeTextRow label="Referencia" value={reference} />
            <FreeTextRow label="Notas" value={paymentNotes} />
            <FreeTextRow label="Motivo de la reversión" value={reversal} />
          </ul>}
        </li>;
      })}</ul>
    </>}
  </>;
}
