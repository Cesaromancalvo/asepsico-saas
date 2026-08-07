import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import request = require('supertest');
import { PatientsController } from '../src/patients/patients.controller';
import { PatientsService } from '../src/patients/patients.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { CsrfGuard } from '../src/common/guards/csrf.guard';

const actor = { sub: 'user-1', workspaceId: 'ws-1', role: 'OWNER', email: 'owner@example.com' };

class TestJwtGuard {
  canActivate(context: any) {
    context.switchToHttp().getRequest().user = actor;
    return true;
  }
}

describe('Patients HTTP security integration', () => {
  let app: INestApplication;
  const patients = {
    list: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    createTherapyGoal: jest.fn().mockResolvedValue({ id: 'goal-1' }),
    createClinicalAssessment: jest.fn().mockResolvedValue({ id: 'assessment-1' }),
  } as any;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PatientsController],
      providers: [
        { provide: PatientsService, useValue: patients },
        CsrfGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(() => app.close());

  it('permite GET autenticado sin token CSRF', async () => {
    await request(app.getHttpServer()).get('/api/v1/patients').expect(200);
  });

  it('bloquea POST sin token CSRF', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/patients/patient-1/goals')
      .send({ title: 'Reducir evitación' })
      .expect(403);
    expect(patients.createTherapyGoal).not.toHaveBeenCalled();
  });

  it('bloquea POST con token CSRF distinto', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/patients/patient-1/goals')
      .set('Cookie', 'csrf_token=token-a')
      .set('x-csrf-token', 'token-b')
      .send({ title: 'Reducir evitación' })
      .expect(403);
  });

  it('permite POST con double-submit CSRF coincidente', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/patients/patient-1/goals')
      .set('Cookie', 'csrf_token=token-a')
      .set('x-csrf-token', 'token-a')
      .send({ title: 'Reducir evitación' })
      .expect(201);
    expect(patients.createTherapyGoal).toHaveBeenCalledWith('ws-1', actor, 'patient-1', expect.any(Object));
  });

  it('rechaza campos inesperados en escalas clínicas', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/patients/patient-1/assessments')
      .set('Cookie', 'csrf_token=token-a')
      .set('x-csrf-token', 'token-a')
      .send({ scaleCode: 'PHQ9', answers: [0,0,0,0,0,0,0,0,0], injected: 'no' })
      .expect(400);
  });
});
