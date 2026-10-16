import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BillingService } from '../src/billing/billing.service';
import { CreateInvoiceDto } from '../src/billing/dto/create-invoice.dto';
import { UpdateInvoiceDto } from '../src/billing/dto/update-invoice.dto';
import { INVOICE_LINE_CONCEPTS, linesForRole, summaryConcept } from '../src/billing/invoice-concepts';

/**
 * Condición de Argos [MEDIA]: recepción (ASSISTANT) tiene acceso a facturación, así que el listado
 * no lleva líneas ni notas (texto libre) y el concepto de una línea es de una lista cerrada.
 */
const actor = (role: string) => ({ sub: `${role}-1`, workspaceId: 'ws-1', role, email: 'x@example.test' }) as any;
const LEGACY = 'Texto libre antiguo que podría ser clínico';

function prismaWith(rows: any[], detail?: any) {
  return {
    invoice: {
      findMany: jest.fn(async (args: any) => {
        // Simula Prisma: devuelve solo lo que pide el select (o todo si no hay select).
        if (!args.select) return rows;
        return rows.map((row) => Object.fromEntries(Object.keys(args.select).filter((k) => k in row).map((k) => [k, k === 'lines' ? row.lines.slice(0, 1).map((l: any) => ({ description: l.description })) : row[k]])));
      }),
      findFirst: jest.fn(async () => detail ?? null),
    },
  } as any;
}

const row = {
  id: 'inv-1', patientId: 'p-1', invoiceNumber: 'FAC-2026-0001', status: 'ISSUED', currency: 'EUR', issueDate: null, dueDate: null,
  subtotalCents: 6000, taxCents: 0, totalCents: 6000, paidCents: 0, createdAt: new Date(), updatedAt: new Date(), notes: 'Nota libre',
  patient: { id: 'p-1', firstName: 'Paciente', lastName: 'Demo' },
  payments: [],
  lines: [{ id: 'l-1', description: LEGACY, quantity: 1, unitPriceCents: 6000 }],
};

describe('Facturación: el listado no expone líneas ni notas', () => {
  it.each(['ASSISTANT', 'OWNER', 'ADMIN'])('%s no recibe lines[].description ni notes en GET /billing/invoices', async (role) => {
    const prisma = prismaWith([row]);
    const list = await new BillingService(prisma).list('ws-1', actor(role));
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('lines');
    expect(list[0]).not.toHaveProperty('notes');
    expect(JSON.stringify(list)).not.toContain(LEGACY);
    expect(list[0].concept).toBe('Otro concepto');
    const args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ workspaceId: 'ws-1' });
    expect(args.include).toBeUndefined();
    expect(args.select.lines).toEqual(expect.objectContaining({ select: { description: true }, take: 1 }));
    expect(args.select.notes).toBeUndefined();
    expect(args.select.payments.select).toEqual({ id: true, amountCents: true, method: true, paidAt: true });
  });

  it('el concepto resumido es el de la primera línea si es del catálogo', () => {
    expect(summaryConcept([{ description: 'Sesión de pareja' }])).toBe('Sesión de pareja');
    expect(summaryConcept([{ description: LEGACY }])).toBe('Otro concepto');
    expect(summaryConcept([])).toBeNull();
  });
});

describe('Facturación: detalle con líneas', () => {
  it('ASSISTANT recibe "Otro concepto" en lugar de un texto libre antiguo; OWNER/ADMIN lo ven', async () => {
    const detail = { ...row, lines: [...row.lines, { id: 'l-2', description: 'Sesión individual', quantity: 1, unitPriceCents: 6000 }] };
    const asAssistant: any = await new BillingService(prismaWith([], detail)).get('ws-1', actor('ASSISTANT'), 'inv-1');
    expect(JSON.stringify(asAssistant.lines)).not.toContain(LEGACY);
    expect(asAssistant.lines[0]).toMatchObject({ description: 'Otro concepto', legacyDescriptionHidden: true });
    expect(asAssistant.lines[1]).toMatchObject({ description: 'Sesión individual' });
    for (const role of ['OWNER', 'ADMIN']) {
      const asAdmin: any = await new BillingService(prismaWith([], detail)).get('ws-1', actor(role), 'inv-1');
      expect(asAdmin.lines[0].description).toBe(LEGACY);
    }
  });

  it('linesForRole falla en cerrado con un rol desconocido', () => {
    expect(linesForRole([{ description: LEGACY }], 'OTRO')[0].description).toBe('Otro concepto');
    expect(linesForRole(undefined, 'OWNER')).toEqual([]);
  });

  it('todas las respuestas de factura pasan por forRole y las de pago por paymentForRole', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'billing', 'billing.service.ts'), 'utf8');
    expect((src.match(/lines: true/g) ?? []).length).toBe(1); // solo INVOICE_DETAIL_INCLUDE
    expect((src.match(/return this\.forRole\(/g) ?? []).length).toBe(5); // get, create, update, issue, void
    expect(src).not.toMatch(/return (payment|existing|updatedPayment);/);
  });

  it('ASSISTANT no recibe notas, motivo de anulación ni notas/referencia/motivo de los pagos; solo indicadores', async () => {
    const detail = {
      ...row, notes: 'Nota libre con algo sensible', voidReason: 'Motivo libre',
      payments: [{ id: 'pay-1', amountCents: 6000, method: 'CARD', notes: 'Nota del pago', reference: 'Ref libre', reversalReason: null }],
    };
    const asAssistant: any = await new BillingService(prismaWith([], detail)).get('ws-1', actor('ASSISTANT'), 'inv-1');
    const json = JSON.stringify(asAssistant);
    for (const text of ['Nota libre con algo sensible', 'Motivo libre', 'Nota del pago', 'Ref libre', LEGACY]) expect(json).not.toContain(text);
    expect(asAssistant).toMatchObject({ notes: null, notesHidden: true, voidReason: null, voidReasonHidden: true });
    expect(asAssistant.payments[0]).toMatchObject({ notes: null, notesHidden: true, reference: null, referenceHidden: true, reversalReason: null });
    expect(asAssistant.payments[0]).not.toHaveProperty('reversalReasonHidden');
    for (const role of ['OWNER', 'ADMIN']) {
      const asAdmin: any = await new BillingService(prismaWith([], detail)).get('ws-1', actor(role), 'inv-1');
      expect(asAdmin.payments[0].notes).toBe('Nota del pago');
      expect(asAdmin.notes).toBe('Nota libre con algo sensible');
    }
  });

  it('el pago devuelto a ASSISTANT al registrarlo o revertirlo tampoco lleva texto libre', async () => {
    const tx: any = {
      payment: {
        create: jest.fn(async ({ data }: any) => ({ id: 'pay-1', ...data })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findFirst: jest.fn(async () => ({ id: 'pay-1', notes: 'Nota del pago', reference: 'Ref', reversalReason: 'Motivo' })),
        aggregate: jest.fn(async () => ({ _sum: { amountCents: 0 } })),
      },
      invoice: { updateMany: jest.fn(async () => ({ count: 1 })) },
      auditLog: { create: jest.fn() },
    };
    const prisma: any = {
      invoice: { findFirst: jest.fn(async () => ({ id: 'inv-1', patientId: 'p-1', status: 'ISSUED', totalCents: 6000, payments: [] })) },
      payment: { findFirst: jest.fn(async () => ({ id: 'pay-1', invoiceId: 'inv-1', reversedAt: null, invoice: { totalCents: 6000 } })) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    const service = new BillingService(prisma);
    const created: any = await service.recordPayment('ws-1', actor('ASSISTANT'), { invoiceId: 'inv-1', amountCents: 1000, method: 'CARD', notes: 'Nota del pago', reference: 'Ref' } as any);
    expect(created).toMatchObject({ notes: null, notesHidden: true, reference: null, referenceHidden: true });
    const reversed: any = await service.reversePayment('ws-1', actor('ASSISTANT'), 'pay-1', 'Motivo');
    expect(JSON.stringify(reversed)).not.toMatch(/Nota del pago|"Ref"|Motivo/);
    // Escrituras acotadas al workspace.
    expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pay-1', workspaceId: 'ws-1', reversedAt: null } }));
    for (const call of tx.invoice.updateMany.mock.calls) expect(call[0].where).toMatchObject({ workspaceId: 'ws-1' });
  });
});

describe('Facturación: ninguna escritura solo por id (regla dura 1)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'billing', 'billing.service.ts'), 'utf8');

  it('no usa update/delete/upsert por clave única sobre facturas, líneas ni pagos', () => {
    expect(src).not.toMatch(/\.(invoice|invoiceLine|payment)\.(update|delete|upsert)\(/);
  });

  it('toda updateMany/deleteMany lleva workspaceId en el where', () => {
    const writes = [...src.matchAll(/\.(invoice|invoiceLine|payment)\.(updateMany|deleteMany)\(\{ where: ([^}]*\}?[^}]*)\}/g)];
    const helper = /scopedInvoiceUpdate\(tx, \{ ([^}]*)\}/g;
    expect(writes.length + [...src.matchAll(helper)].length).toBeGreaterThan(0);
    for (const m of writes) expect(m[3]).toMatch(/workspaceId/);
    for (const m of src.matchAll(helper)) expect(m[1]).toMatch(/workspaceId/);
    expect(src).toMatch(/updateMany\(\{ where, data \}\)/);
  });

  it('editar, emitir y anular comprueban el estado en la propia escritura (compare-and-set)', async () => {
    const tx: any = {
      invoice: { updateMany: jest.fn(async () => ({ count: 0 })), findFirst: jest.fn() },
      invoiceLine: { deleteMany: jest.fn(), createMany: jest.fn() }, auditLog: { create: jest.fn() },
    };
    const prisma: any = { invoice: { findFirst: jest.fn(async () => ({ id: 'inv-1', status: 'DRAFT', payments: [] })) }, $transaction: jest.fn(async (cb: any) => cb(tx)) };
    const service = new BillingService(prisma);
    await expect(service.issue('ws-1', actor('OWNER'), 'inv-1')).rejects.toMatchObject({ status: 400 });
    expect(tx.invoice.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'inv-1', workspaceId: 'ws-1', status: 'DRAFT' } }));
    await expect(service.update('ws-1', actor('OWNER'), 'inv-1', { lines: [{ description: 'Sesión', quantity: 1, unitPriceCents: 6000 }] } as any)).rejects.toMatchObject({ status: 400 });
    expect(tx.invoiceLine.deleteMany).not.toHaveBeenCalled(); // no toca líneas si la factura no es suya o ya no es borrador
  });
});

describe('Facturación: concepto de línea de una lista cerrada', () => {
  const errors = (cls: any, body: any) => validateSync(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true });
  const line = (description: unknown) => ({ description, quantity: 1, unitPriceCents: 6000 });

  it.each(INVOICE_LINE_CONCEPTS.map((c) => [c]))('acepta "%s"', (concept) => {
    expect(errors(CreateInvoiceDto, { patientId: 'p-1', lines: [line(concept)] })).toHaveLength(0);
  });

  it.each([
    'Sesión por ansiedad generalizada',
    'Terapia por motivo X',
    'sesión',
    ' Sesión',
    '',
    123,
  ])('rechaza %j (crear y editar)', (concept) => {
    expect(errors(CreateInvoiceDto, { patientId: 'p-1', lines: [line(concept)] }).length).toBeGreaterThan(0);
    expect(errors(UpdateInvoiceDto, { lines: [line(concept)] }).length).toBeGreaterThan(0);
  });

  it('la lista de la web (packages/contracts) es idéntica a la de la API', () => {
    const contracts = readFileSync(join(__dirname, '..', '..', '..', 'packages', 'contracts', 'src', 'index.ts'), 'utf8');
    const match = contracts.match(/INVOICE_LINE_CONCEPTS = (\[[^\]]+\])/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1].replace(/'/g, '"'))).toEqual([...INVOICE_LINE_CONCEPTS]);
  });
});
