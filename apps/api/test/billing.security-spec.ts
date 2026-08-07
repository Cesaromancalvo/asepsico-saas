import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BillingService } from '../src/billing/billing.service';

const owner = { sub:'owner-1', workspaceId:'ws-1', role:'OWNER', email:'o@example.com' } as any;
const therapist = { sub:'therapist-1', workspaceId:'ws-1', role:'THERAPIST', email:'t@example.com' } as any;
const assistant = { sub:'assistant-1', workspaceId:'ws-1', role:'ASSISTANT', email:'a@example.com' } as any;

function mockPrisma() {
  const tx:any = {
    invoice: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    invoiceLine: { deleteMany: jest.fn() }, payment: { create: jest.fn(), update: jest.fn(), aggregate: jest.fn() },
    auditLog: { create: jest.fn() }, notification: { upsert: jest.fn() }, notificationDelivery: { upsert: jest.fn() }, $executeRawUnsafe: jest.fn(),
  };
  return {
    patient: { findFirst: jest.fn() }, invoice: { findMany: jest.fn(), findFirst: jest.fn() }, payment: { findFirst: jest.fn() }, notificationPreference: { findUnique: jest.fn() },
    $transaction: jest.fn(async (cb:any) => cb(tx)), __tx: tx,
  } as any;
}

describe('BillingService security and accounting invariants', () => {
  it('blocks therapists from financial data', async () => {
    const service = new BillingService(mockPrisma());
    await expect(service.list('ws-1', therapist)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows assistants to list billing without clinical narrative', async () => {
    const prisma = mockPrisma(); prisma.invoice.findMany.mockResolvedValue([]);
    const service = new BillingService(prisma);
    await expect(service.list('ws-1', assistant)).resolves.toEqual([]);
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId:'ws-1' } }));
  });

  it('does not reveal invoices from another workspace', async () => {
    const prisma = mockPrisma(); prisma.invoice.findFirst.mockResolvedValue(null);
    const service = new BillingService(prisma);
    await expect(service.get('ws-1', owner, 'invoice-ws-2')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.invoice.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where:{ id:'invoice-ws-2', workspaceId:'ws-1' } }));
  });

  it('calculates totals on the server and audits invoice creation', async () => {
    const prisma = mockPrisma();
    prisma.patient.findFirst.mockResolvedValue({ id:'patient-1' });
    prisma.__tx.invoice.findFirst.mockResolvedValue({ sequence: 4 });
    prisma.__tx.invoice.create.mockImplementation(async ({data}:any) => ({ id:'inv-1', ...data }));
    const service = new BillingService(prisma);
    const result:any = await service.create('ws-1', owner, { patientId:'patient-1', lines:[{description:'Sesión',quantity:2,unitPriceCents:6000,taxRateBps:2100}] } as any);
    expect(result.totalCents).toBe(14520);
    expect(result.invoiceNumber).toBe('FAC-2026-0005');
    expect(prisma.__tx.auditLog.create).toHaveBeenCalled();
  });

  it('rejects overpayments', async () => {
    const prisma = mockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ id:'inv-1', patientId:'p-1', status:'ISSUED', totalCents:6000, payments:[{amountCents:2000}] });
    const service = new BillingService(prisma);
    await expect(service.recordPayment('ws-1', owner, { invoiceId:'inv-1', amountCents:5000, method:'CARD' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('idempotency prevents duplicate payment records', async () => {
    const prisma = mockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ id:'inv-1', patientId:'p-1', status:'ISSUED', totalCents:6000, payments:[] });
    prisma.payment.findFirst.mockResolvedValue({ id:'pay-existing', invoiceId:'inv-1', amountCents:6000, method:'CARD' });
    const service = new BillingService(prisma);
    const result:any = await service.recordPayment('ws-1', owner, { invoiceId:'inv-1', amountCents:6000, method:'CARD', idempotencyKey:'same-request' } as any);
    expect(result.id).toBe('pay-existing');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for a different payment', async () => {
    const prisma = mockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ id:'inv-1', patientId:'p-1', status:'ISSUED', totalCents:6000, payments:[] });
    prisma.payment.findFirst.mockResolvedValue({ id:'pay-existing', invoiceId:'another-invoice', amountCents:6000, method:'CARD' });
    const service = new BillingService(prisma);
    await expect(service.recordPayment('ws-1', owner, { invoiceId:'inv-1', amountCents:6000, method:'CARD', idempotencyKey:'reused-key' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('cannot void invoices with active payments', async () => {
    const prisma = mockPrisma(); prisma.invoice.findFirst.mockResolvedValue({ id:'inv-1', status:'PARTIALLY_PAID', payments:[{id:'p'}] });
    const service = new BillingService(prisma);
    await expect(service.void('ws-1', owner, 'inv-1', 'Error')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sends an issued invoice to the patient portal and audits it', async () => {
    const prisma = mockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({
      id:'inv-1', workspaceId:'ws-1', patientId:'p-1', invoiceNumber:'FAC-2026-0001',
      status:'ISSUED', totalCents:6000,
      patient:{ id:'p-1', firstName:'Ana', lastName:'Pérez', email:'ana@example.com', portalAccount:{id:'portal-1',isActive:true,email:'ana@example.com'} },
    });
    prisma.notificationPreference.findUnique.mockResolvedValue({ emailEnabled:true });
    prisma.__tx.notification.upsert.mockResolvedValue({ id:'notification-1' });
    const service = new BillingService(prisma);
    const result:any = await service.sendToPatient('ws-1', owner, 'inv-1');
    expect(result.ok).toBe(true);
    expect(result.channels).toEqual(['IN_APP','EMAIL']);
    expect(prisma.__tx.notification.upsert).toHaveBeenCalled();
    expect(prisma.__tx.notificationDelivery.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({action:'INVOICE_SENT_TO_PATIENT'})}));
  });

  it('does not send draft invoices', async () => {
    const prisma = mockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ id:'inv-1', status:'DRAFT', patientId:'p-1', patient:{portalAccount:{isActive:true}} });
    const service = new BillingService(prisma);
    await expect(service.sendToPatient('ws-1', owner, 'inv-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

});
