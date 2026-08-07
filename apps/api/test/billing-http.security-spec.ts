import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as request from 'supertest';
import { BillingController } from '../src/billing/billing.controller';
import { BillingService } from '../src/billing/billing.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { CsrfGuard } from '../src/common/guards/csrf.guard';

const actor = { sub:'owner-1', workspaceId:'ws-1', role:'OWNER', email:'o@example.com' };
class TestJwtGuard { canActivate(context:any) { context.switchToHttp().getRequest().user = actor; return true; } }

describe('Billing HTTP integration security', () => {
  let app: INestApplication;
  const billing = { create: jest.fn().mockResolvedValue({id:'inv-1'}), recordPayment: jest.fn().mockResolvedValue({id:'pay-1'}), list: jest.fn(), get: jest.fn(), summary: jest.fn(), update: jest.fn(), issue: jest.fn(), void: jest.fn(), reversePayment: jest.fn() } as any;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers:[BillingController], providers:[{provide:BillingService,useValue:billing}, CsrfGuard] })
      .overrideGuard(JwtAuthGuard).useClass(TestJwtGuard).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1'); app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist:true, forbidNonWhitelisted:true, transform:true }));
    await app.init();
  });
  afterAll(() => app.close());

  it('blocks invoice creation without CSRF', async () => {
    await request(app.getHttpServer()).post('/api/v1/billing/invoices').send({ patientId:'p-1', lines:[{description:'Sesión',quantity:1,unitPriceCents:6000}] }).expect(403);
    expect(billing.create).not.toHaveBeenCalled();
  });

  it('accepts valid invoice with matching double-submit CSRF', async () => {
    await request(app.getHttpServer()).post('/api/v1/billing/invoices').set('Cookie','csrf_token=x').set('x-csrf-token','x')
      .send({ patientId:'p-1', lines:[{description:'Sesión',quantity:1,unitPriceCents:6000}] }).expect(201);
    expect(billing.create).toHaveBeenCalledWith('ws-1', actor, expect.any(Object));
  });

  it('rejects client-supplied totals and unexpected fields', async () => {
    await request(app.getHttpServer()).post('/api/v1/billing/invoices').set('Cookie','csrf_token=x').set('x-csrf-token','x')
      .send({ patientId:'p-1', totalCents:1, lines:[{description:'Sesión',quantity:1,unitPriceCents:6000}] }).expect(400);
  });

  it('rejects invalid payment method', async () => {
    await request(app.getHttpServer()).post('/api/v1/billing/payments').set('Cookie','csrf_token=x').set('x-csrf-token','x')
      .send({ invoiceId:'inv-1', amountCents:6000, method:'CRYPTO' }).expect(400);
  });
});
