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

  it('todas las respuestas con líneas pasan por forRole', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'billing', 'billing.service.ts'), 'utf8');
    const withLines = (src.match(/lines: true/g) ?? []).length;
    expect(withLines).toBeGreaterThan(0);
    expect((src.match(/return this\.forRole\(/g) ?? []).length).toBe(withLines);
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
