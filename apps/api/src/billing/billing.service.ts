import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { CreateInvoiceDto, CreateInvoiceLineDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';

@Injectable()
export class BillingService {
  constructor(private prisma: PrismaService) {}

  private assertBillingRole(actor: AuthUser) {
    if (!['OWNER', 'ADMIN', 'ASSISTANT'].includes(actor.role)) {
      throw new ForbiddenException('No tienes permisos para acceder a facturación');
    }
  }

  private calculate(lines: CreateInvoiceLineDto[]) {
    const calculated = lines.map((line) => {
      const lineSubtotalCents = line.quantity * line.unitPriceCents;
      const taxRateBps = line.taxRateBps ?? 0;
      const lineTaxCents = Math.round((lineSubtotalCents * taxRateBps) / 10_000);
      return { ...line, taxRateBps, lineSubtotalCents, lineTaxCents, lineTotalCents: lineSubtotalCents + lineTaxCents };
    });
    return {
      lines: calculated,
      subtotalCents: calculated.reduce((sum, line) => sum + line.lineSubtotalCents, 0),
      taxCents: calculated.reduce((sum, line) => sum + line.lineTaxCents, 0),
      totalCents: calculated.reduce((sum, line) => sum + line.lineTotalCents, 0),
    };
  }

  async list(workspaceId: string, actor: AuthUser, patientId?: string) {
    this.assertBillingRole(actor);
    return (this.prisma as any).invoice.findMany({
      where: { workspaceId, ...(patientId ? { patientId } : {}) },
      include: { patient: { select: { id: true, firstName: true, lastName: true } }, lines: true, payments: { where: { reversedAt: null }, orderBy: { paidAt: 'desc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(workspaceId: string, actor: AuthUser, id: string) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({
      where: { id, workspaceId }, include: { patient: { select: { id: true, firstName: true, lastName: true, email: true } }, lines: true, payments: { orderBy: { paidAt: 'desc' } } },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    return invoice;
  }

  async create(workspaceId: string, actor: AuthUser, dto: CreateInvoiceDto) {
    this.assertBillingRole(actor);
    const patient = await (this.prisma as any).patient.findFirst({ where: { id: dto.patientId, workspaceId, deletedAt: null } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    const amounts = this.calculate(dto.lines);
    if (amounts.totalCents <= 0) throw new BadRequestException('El total debe ser mayor que cero');

    return (this.prisma as any).$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', workspaceId);
      const latest = await tx.invoice.findFirst({ where: { workspaceId }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
      const sequence = (latest?.sequence ?? 0) + 1;
      const invoiceNumber = `FAC-${new Date().getFullYear()}-${String(sequence).padStart(4, '0')}`;
      const invoice = await tx.invoice.create({
        data: {
          workspaceId, patientId: dto.patientId, sequence, invoiceNumber, currency: (dto.currency ?? 'EUR').toUpperCase(),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null, notes: dto.notes,
          subtotalCents: amounts.subtotalCents, taxCents: amounts.taxCents, totalCents: amounts.totalCents,
          createdById: actor.sub, lines: { create: amounts.lines },
        }, include: { patient: { select: { id: true, firstName: true, lastName: true, email: true } }, lines: true, payments: true },
      });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'INVOICE_CREATED', entityType: 'Invoice', entityId: invoice.id, metadata: { invoiceNumber, totalCents: amounts.totalCents } } });
      return invoice;
    });
  }

  async update(workspaceId: string, actor: AuthUser, id: string, dto: UpdateInvoiceDto) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({ where: { id, workspaceId }, include: { payments: { where: { reversedAt: null } } } });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (invoice.status !== 'DRAFT') throw new BadRequestException('Solo se pueden editar facturas en borrador');
    const amounts = dto.lines ? this.calculate(dto.lines) : null;
    return (this.prisma as any).$transaction(async (tx: any) => {
      if (dto.lines) await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      const updated = await tx.invoice.update({
        where: { id },
        data: {
          dueDate: dto.dueDate ? new Date(dto.dueDate) : dto.dueDate === undefined ? undefined : null,
          notes: dto.notes,
          ...(amounts ? { subtotalCents: amounts.subtotalCents, taxCents: amounts.taxCents, totalCents: amounts.totalCents, lines: { create: amounts.lines } } : {}),
        }, include: { patient: { select: { id: true, firstName: true, lastName: true, email: true } }, lines: true, payments: true },
      });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'INVOICE_UPDATED', entityType: 'Invoice', entityId: id } });
      return updated;
    });
  }

  async issue(workspaceId: string, actor: AuthUser, id: string) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({ where: { id, workspaceId } });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (invoice.status !== 'DRAFT') throw new BadRequestException('La factura no está en borrador');
    return (this.prisma as any).$transaction(async (tx: any) => {
      const updated = await tx.invoice.update({ where: { id }, data: { status: 'ISSUED', issueDate: new Date() }, include: { patient: { select: { id: true, firstName: true, lastName: true, email: true } }, lines: true, payments: true } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'INVOICE_ISSUED', entityType: 'Invoice', entityId: id } });
      return updated;
    });
  }

  async void(workspaceId: string, actor: AuthUser, id: string, reason: string) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({ where: { id, workspaceId }, include: { payments: { where: { reversedAt: null } } } });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (invoice.status === 'PAID' || invoice.payments.length) throw new BadRequestException('No se puede anular una factura con pagos activos');
    if (invoice.status === 'VOID') throw new BadRequestException('La factura ya está anulada');
    return (this.prisma as any).$transaction(async (tx: any) => {
      const updated = await tx.invoice.update({ where: { id }, data: { status: 'VOID', voidReason: reason }, include: { patient: { select: { id: true, firstName: true, lastName: true, email: true } }, lines: true, payments: true } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'INVOICE_VOIDED', entityType: 'Invoice', entityId: id, metadata: { reason } } });
      return updated;
    });
  }

  async recordPayment(workspaceId: string, actor: AuthUser, dto: CreatePaymentDto) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({ where: { id: dto.invoiceId, workspaceId }, include: { payments: { where: { reversedAt: null } } } });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (!['ISSUED','PARTIALLY_PAID','OVERDUE'].includes(invoice.status)) throw new BadRequestException('La factura no admite pagos');
    const activePaid = invoice.payments.reduce((sum: number, payment: any) => sum + payment.amountCents, 0);
    if (dto.amountCents > invoice.totalCents - activePaid) throw new BadRequestException('El pago supera el saldo pendiente');

    if (dto.idempotencyKey) {
      const existing = await (this.prisma as any).payment.findFirst({ where: { workspaceId, idempotencyKey: dto.idempotencyKey } });
      if (existing) {
        const sameOperation = existing.invoiceId === dto.invoiceId
          && existing.amountCents === dto.amountCents
          && existing.method === dto.method;
        if (!sameOperation) {
          throw new BadRequestException('La clave de idempotencia ya se utilizó para otra operación');
        }
        return existing;
      }
    }

    return (this.prisma as any).$transaction(async (tx: any) => {
      const payment = await tx.payment.create({ data: {
        workspaceId, patientId: invoice.patientId, invoiceId: invoice.id, amountCents: dto.amountCents,
        method: dto.method, paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(), reference: dto.reference,
        idempotencyKey: dto.idempotencyKey, notes: dto.notes, recordedById: actor.sub,
      }});
      const paidCents = activePaid + dto.amountCents;
      await tx.invoice.update({ where: { id: invoice.id }, data: { paidCents, status: paidCents === invoice.totalCents ? 'PAID' : 'PARTIALLY_PAID' } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'PAYMENT_RECORDED', entityType: 'Payment', entityId: payment.id, metadata: { invoiceId: invoice.id, amountCents: dto.amountCents, method: dto.method } } });
      return payment;
    });
  }

  async reversePayment(workspaceId: string, actor: AuthUser, paymentId: string, reason: string) {
    this.assertBillingRole(actor);
    const payment = await (this.prisma as any).payment.findFirst({ where: { id: paymentId, workspaceId }, include: { invoice: true } });
    if (!payment) throw new NotFoundException('Pago no encontrado');
    if (payment.reversedAt) throw new BadRequestException('El pago ya está revertido');
    return (this.prisma as any).$transaction(async (tx: any) => {
      const updatedPayment = await tx.payment.update({ where: { id: paymentId }, data: { reversedAt: new Date(), reversalReason: reason } });
      const aggregate = await tx.payment.aggregate({ where: { invoiceId: payment.invoiceId, reversedAt: null, id: { not: paymentId } }, _sum: { amountCents: true } });
      const paidCents = aggregate._sum.amountCents ?? 0;
      await tx.invoice.update({ where: { id: payment.invoiceId }, data: { paidCents, status: paidCents === 0 ? 'ISSUED' : paidCents >= payment.invoice.totalCents ? 'PAID' : 'PARTIALLY_PAID' } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'PAYMENT_REVERSED', entityType: 'Payment', entityId: paymentId, metadata: { invoiceId: payment.invoiceId, reason } } });
      return updatedPayment;
    });
  }

  async sendToPatient(workspaceId: string, actor: AuthUser, id: string) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({
      where: { id, workspaceId },
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            portalAccount: { select: { id: true, isActive: true, email: true } },
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (invoice.status === 'DRAFT') throw new BadRequestException('Emite la factura antes de enviarla');
    if (invoice.status === 'VOID') throw new BadRequestException('No se puede enviar una factura anulada');

    const hasPortal = Boolean(invoice.patient.portalAccount?.isActive);
    const email = invoice.patient.portalAccount?.email || invoice.patient.email;
    if (!hasPortal && !email) {
      throw new BadRequestException('El paciente necesita un portal activo o un correo electrónico para recibir la factura');
    }

    const preferences = await (this.prisma as any).notificationPreference.findUnique({
      where: { patientId: invoice.patientId },
    });
    const channels = ['IN_APP'];
    if (email && preferences?.emailEnabled) channels.push('EMAIL');

    return (this.prisma as any).$transaction(async (tx: any) => {
      const notification = await tx.notification.upsert({
        where: { dedupeKey: `invoice:${invoice.id}:shared` },
        create: {
          workspaceId,
          audience: 'PATIENT',
          patientId: invoice.patientId,
          type: 'INVOICE_DUE',
          title: `Factura ${invoice.invoiceNumber}`,
          body: `Tienes disponible una factura por ${(invoice.totalCents / 100).toFixed(2)} EUR.`,
          actionUrl: '/portal',
          status: 'SENT',
          scheduledAt: new Date(),
          sentAt: new Date(),
          dedupeKey: `invoice:${invoice.id}:shared`,
          metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
        },
        update: {
          status: 'SENT',
          readAt: null,
          sentAt: new Date(),
          body: `Tienes disponible una factura por ${(invoice.totalCents / 100).toFixed(2)} EUR.`,
        },
      });

      for (const channel of channels) {
        await tx.notificationDelivery.upsert({
          where: { notificationId_channel: { notificationId: notification.id, channel } },
          create: {
            notificationId: notification.id,
            channel,
            status: channel === 'IN_APP' ? 'SENT' : 'PENDING',
            attemptedAt: channel === 'IN_APP' ? new Date() : null,
          },
          update: {
            status: channel === 'IN_APP' ? 'SENT' : 'PENDING',
            attemptedAt: channel === 'IN_APP' ? new Date() : null,
            errorCode: null,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'INVOICE_SENT_TO_PATIENT',
          entityType: 'Invoice',
          entityId: invoice.id,
          metadata: { patientId: invoice.patientId, channels },
        },
      });
      return { ok: true, invoiceId: invoice.id, channels, recipient: email ?? 'portal' };
    });
  }

  async summary(workspaceId: string, actor: AuthUser) {
    this.assertBillingRole(actor);
    const invoices = await (this.prisma as any).invoice.findMany({ where: { workspaceId, status: { not: 'VOID' } }, select: { totalCents: true, paidCents: true, status: true, dueDate: true } });
    const now = new Date();
    return {
      invoicedCents: invoices.reduce((s: number, i: any) => s + i.totalCents, 0),
      collectedCents: invoices.reduce((s: number, i: any) => s + i.paidCents, 0),
      outstandingCents: invoices.reduce((s: number, i: any) => s + Math.max(0, i.totalCents - i.paidCents), 0),
      overdueCount: invoices.filter((i: any) => i.dueDate && i.dueDate < now && !['PAID','VOID'].includes(i.status)).length,
    };
  }
}
