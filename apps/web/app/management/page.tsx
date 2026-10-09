'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api } from '@/lib/api';
import { INVOICE_LINE_CONCEPTS, type InvoiceLineConcept, type InvoiceListItemContract } from '@asepsico/contracts';

type Patient = { id: string; firstName: string; lastName: string };
type Payment = { id: string; amountCents: number; method: string; paidAt: string; reversedAt?: string | null };
// GET /billing/invoices: resumen sin líneas ni notas. `concept` es el de la primera línea (lista cerrada).
type Invoice = Pick<InvoiceListItemContract, 'id' | 'invoiceNumber' | 'status' | 'totalCents' | 'paidCents' | 'dueDate' | 'concept' | 'patient'> & { payments: Payment[] };
// GET /billing/invoices/:id: detalle con líneas. Un texto libre antiguo fuera del catálogo llega a
// recepción como legacyDescriptionHidden: se muestra "Otro concepto" y nada más.
type InvoiceLine = { id: string; description: string; quantity: number; unitPriceCents: number; legacyDescriptionHidden?: true };
type InvoiceDetail = { id: string; lines: InvoiceLine[] };
type Summary = { invoicedCents: number; collectedCents: number; outstandingCents: number; overdueCount: number };

const money = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const lineLabel = (line: InvoiceLine) => (line.legacyDescriptionHidden ? 'Otro concepto' : line.description);
const labels: Record<string,string> = { DRAFT:'Borrador', ISSUED:'Emitida', PARTIALLY_PAID:'Pago parcial', PAID:'Pagada', VOID:'Anulada', OVERDUE:'Vencida' };

export default function ManagementPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [summary, setSummary] = useState<Summary>({ invoicedCents:0, collectedCents:0, outstandingCents:0, overdueCount:0 });
  const [patientId, setPatientId] = useState('');
  const [description, setDescription] = useState<InvoiceLineConcept>('Sesión de psicología');
  const [detail, setDetail] = useState<{ id: string; state: 'loading' | 'ready' | 'error'; lines: InvoiceLine[] } | null>(null);
  const [amount, setAmount] = useState('60');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

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
      if (!patientId || !description || !Number.isFinite(unitPriceCents) || unitPriceCents <= 0) throw new Error('Revisa los datos de la factura');
      await api('/billing/invoices', { method:'POST', body: JSON.stringify({ patientId, dueDate: dueDate || undefined, lines:[{ description, quantity:1, unitPriceCents, taxRateBps:0 }] }) });
      setMessage('Factura guardada como borrador. Emítela y después podrás enviarla al paciente.');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo crear'); } finally { setBusy(false); }
  }

  async function toggleDetail(invoice: Invoice) {
    if (detail?.id === invoice.id) { setDetail(null); return; }
    setDetail({ id: invoice.id, state: 'loading', lines: [] });
    try {
      const data = await api<InvoiceDetail>(`/billing/invoices/${invoice.id}`);
      setDetail((current) => (current?.id === invoice.id ? { id: invoice.id, state: 'ready', lines: data.lines ?? [] } : current));
    } catch {
      setDetail((current) => (current?.id === invoice.id ? { id: invoice.id, state: 'error', lines: [] } : current));
    }
  }

  async function action(path: string, body?: object, successMessage='Operación completada') {
    setBusy(true); setError(''); setMessage('');
    try { await api(path, { method:'POST', body: JSON.stringify(body ?? {}) }); setMessage(successMessage); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Operación fallida'); } finally { setBusy(false); }
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
    <header className="patient-record-header"><div><span className="eyebrow">Gestión económica</span><h1>Facturación y cobros</h1><p>Control sencillo de facturas, saldos y pagos de la consulta.</p></div></header>
    {error && <div className="agenda-error">{error}</div>}
    {message && <div className="patient-save-state">{message}</div>}
    <section className="billing-kpis">
      <article><span>Facturado</span><strong>{money(summary.invoicedCents)}</strong></article>
      <article><span>Cobrado</span><strong>{money(summary.collectedCents)}</strong></article>
      <article><span>Pendiente</span><strong>{money(summary.outstandingCents)}</strong></article>
      <article><span>Vencidas</span><strong>{summary.overdueCount}</strong></article>
    </section>
    <section className="patient-card billing-create"><h2>Nueva factura</h2><form onSubmit={createInvoice} className="billing-form">
      <label>Paciente<select value={patientId} onChange={(e)=>setPatientId(e.target.value)}>{patients.map(p=><option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}</select></label>
      <label>Concepto
        <select value={description} onChange={(e)=>setDescription(e.target.value as InvoiceLineConcept)} aria-describedby="invoice-concept-hint">
          {INVOICE_LINE_CONCEPTS.map((concept) => <option key={concept} value={concept}>{concept}</option>)}
        </select>
        {/* [CLIO] Texto del aviso pendiente de revisión. */}
        <small id="invoice-concept-hint" className="demo-hint">No escribas información clínica en las facturas.</small>
      </label>
      <label>Importe (€)<input inputMode="decimal" value={amount} onChange={(e)=>setAmount(e.target.value)} /></label>
      <label>Vencimiento<input type="date" value={dueDate} onChange={(e)=>setDueDate(e.target.value)} /></label>
      <button className="button primary" disabled={busy || !selected}>Crear borrador</button>
    </form></section>
    <section className="patient-card"><div className="section-heading"><div><span className="eyebrow">Histórico</span><h2>Facturas</h2></div></div>
      <div className="billing-list">{invoices.map(invoice => <article key={invoice.id} className="billing-row">
        <div><strong>{invoice.invoiceNumber}</strong><span>{invoice.patient.firstName} {invoice.patient.lastName}</span>{invoice.concept && <small>{invoice.concept}</small>}</div>
        <div><span className={`status-pill ${invoice.status.toLowerCase()}`}>{labels[invoice.status] ?? invoice.status}</span><strong>{money(invoice.totalCents)}</strong><small>Pendiente {money(invoice.totalCents - invoice.paidCents)}</small></div>
        <div className="billing-actions">
          <button type="button" aria-expanded={detail?.id === invoice.id} aria-controls={`invoice-lines-${invoice.id}`} onClick={()=>void toggleDetail(invoice)}>{detail?.id === invoice.id ? 'Ocultar detalle' : 'Ver detalle'}</button>
          {invoice.status === 'DRAFT' && <button disabled={busy} onClick={()=>action(`/billing/invoices/${invoice.id}/issue`, undefined, 'Factura emitida. Ya puedes enviarla al paciente.')}>Emitir</button>}
          {['ISSUED','PARTIALLY_PAID','OVERDUE','PAID'].includes(invoice.status) && <button disabled={busy} onClick={()=>action(`/billing/invoices/${invoice.id}/send`, undefined, 'Factura enviada al portal del paciente. Si tiene el correo activado, queda también preparada para envío por email.')}>Enviar al paciente</button>}
          {['ISSUED','PARTIALLY_PAID','OVERDUE'].includes(invoice.status) && <button disabled={busy} onClick={()=>registerPayment(invoice)}>Registrar pago</button>}
          {!['PAID','VOID'].includes(invoice.status) && invoice.paidCents===0 && <button disabled={busy} onClick={()=>{const reason=window.prompt('Motivo de anulación'); if(reason) action(`/billing/invoices/${invoice.id}/void`,{reason});}}>Anular</button>}
        </div>
        {detail?.id === invoice.id && <div id={`invoice-lines-${invoice.id}`} className="billing-detail">
          {detail.state === 'loading' && <small role="status">Cargando detalle…</small>}
          {detail.state === 'error' && <small role="alert">No se pudo cargar el detalle. Inténtalo de nuevo.</small>}
          {detail.state === 'ready' && (detail.lines.length
            ? <ul>{detail.lines.map((line) => <li key={line.id}><span>{lineLabel(line)}</span><span>{line.quantity} × {money(line.unitPriceCents)}</span></li>)}</ul>
            : <small>Esta factura no tiene conceptos.</small>)}
        </div>}
      </article>)}{!invoices.length && <p>No hay facturas todavía.</p>}</div>
    </section>
  </main></div>;
}
