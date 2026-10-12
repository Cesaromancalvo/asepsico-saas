import { readFileSync } from 'fs';
import { join } from 'path';
import { BillingService } from '../src/billing/billing.service';

/**
 * Hallazgo de Argos [MEDIA]: el motivo de anular una factura o revertir un pago es texto libre.
 * Vive solo en voidReason / reversalReason (que ASSISTANT recibe a null con la marca Hidden) y
 * nunca se copia a AuditLog.metadata (solo nombres de campo e ids: SECURITY_BASELINE).
 */
const actor = (role: string) => ({ sub: `${role}-1`, workspaceId: 'ws-1', role, email: 'x@example.test' }) as any;
const MOTIVO = 'Motivo ficticio con texto libre';

function setup() {
  const tx: any = {
    invoice: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findFirst: jest.fn(async () => ({ id: 'inv-1', status: 'VOID', voidReason: MOTIVO, notes: null, lines: [], payments: [] })),
    },
    payment: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findFirst: jest.fn(async () => ({ id: 'pay-1', invoiceId: 'inv-1', reversedAt: new Date(), reversalReason: MOTIVO, notes: null, reference: null })),
      aggregate: jest.fn(async () => ({ _sum: { amountCents: 0 } })),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma: any = {
    invoice: { findFirst: jest.fn(async () => ({ id: 'inv-1', status: 'ISSUED', payments: [] })) },
    payment: { findFirst: jest.fn(async () => ({ id: 'pay-1', invoiceId: 'inv-1', reversedAt: null, invoice: { totalCents: 6000 } })) },
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  };
  return { service: new BillingService(prisma), tx };
}

function auditMetadata(tx: any, action: string) {
  const call = tx.auditLog.create.mock.calls.find((c: any[]) => c[0].data.action === action);
  expect(call).toBeDefined();
  return call[0].data.metadata;
}

describe('Facturación: el motivo de anulación/reversión no va a la auditoría', () => {
  it.each(['OWNER', 'ADMIN', 'ASSISTANT'])('(a) %s anula una factura: metadata sin reason', async (role) => {
    const { service, tx } = setup();
    await service.void('ws-1', actor(role), 'inv-1', MOTIVO);
    const metadata = auditMetadata(tx, 'INVOICE_VOIDED');
    expect(metadata).toEqual({ invoiceId: 'inv-1', reasonProvided: true });
    expect(JSON.stringify(metadata)).not.toContain(MOTIVO);
    // El motivo sí se guarda en la factura, con escritura acotada al workspace.
    expect(tx.invoice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'inv-1', workspaceId: 'ws-1' }),
      data: expect.objectContaining({ voidReason: MOTIVO }),
    }));
  });

  it.each(['OWNER', 'ADMIN', 'ASSISTANT'])('(a) %s revierte un pago: metadata sin reason', async (role) => {
    const { service, tx } = setup();
    await service.reversePayment('ws-1', actor(role), 'pay-1', MOTIVO);
    const metadata = auditMetadata(tx, 'PAYMENT_REVERSED');
    expect(metadata).toEqual({ invoiceId: 'inv-1', reasonProvided: true });
    expect(JSON.stringify(metadata)).not.toContain(MOTIVO);
    expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'pay-1', workspaceId: 'ws-1', reversedAt: null },
      data: expect.objectContaining({ reversalReason: MOTIVO }),
    }));
  });

  it('(b) ASSISTANT que anula recibe voidReason a null con voidReasonHidden', async () => {
    const { service } = setup();
    const result: any = await service.void('ws-1', actor('ASSISTANT'), 'inv-1', MOTIVO);
    expect(result).toMatchObject({ voidReason: null, voidReasonHidden: true });
    expect(JSON.stringify(result)).not.toContain(MOTIVO);
  });

  it('(b) ASSISTANT que revierte recibe reversalReason a null con reversalReasonHidden', async () => {
    const { service } = setup();
    const result: any = await service.reversePayment('ws-1', actor('ASSISTANT'), 'pay-1', MOTIVO);
    expect(result).toMatchObject({ reversalReason: null, reversalReasonHidden: true });
    expect(JSON.stringify(result)).not.toContain(MOTIVO);
  });

  it('OWNER sigue viendo el motivo en la respuesta (fuente: voidReason / reversalReason)', async () => {
    const { service } = setup();
    expect(((await service.void('ws-1', actor('OWNER'), 'inv-1', MOTIVO)) as any).voidReason).toBe(MOTIVO);
    expect(((await service.reversePayment('ws-1', actor('OWNER'), 'pay-1', MOTIVO)) as any).reversalReason).toBe(MOTIVO);
  });

  it('ninguna auditoría de facturación copia un motivo, nota, referencia o descripción', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'billing', 'billing.service.ts'), 'utf8');
    const metadatas = src.match(/metadata:\s*\{[^}]*\}/g) ?? [];
    expect(metadatas.length).toBeGreaterThan(0);
    for (const m of metadatas) expect(m).not.toMatch(/\b(reason|notes|description|reference|voidReason|reversalReason)\b/);
  });

  it('la migración de datos quita reason de las auditorías existentes y es idempotente', () => {
    const sql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20261012090000_strip_reason_from_billing_audit', 'migration.sql'), 'utf8');
    for (const action of ['INVOICE_VOIDED', 'PAYMENT_REVERSED']) expect(sql).toContain(`"action" = '${action}'`);
    expect((sql.match(/\("metadata" - 'reason'\)/g) ?? []).length).toBe(2);
    expect((sql.match(/"metadata" \? 'reason'/g) ?? []).length).toBe(2);
  });
});
