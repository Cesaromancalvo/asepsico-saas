import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { PatientsModule } from './patients/patients.module';
import { SessionsModule } from './sessions/sessions.module';
import { HealthModule } from './health/health.module';
import { ClinicalProcessesModule } from './clinical-processes/clinical-processes.module';
import { BillingModule } from './billing/billing.module';
import { PortalModule } from './portal/portal.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ResourcesModule } from './resources/resources.module';
import { MessagesModule } from './messages/messages.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ExportsModule } from './exports/exports.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Límite global por defecto para toda la API (además del límite más estricto en auth).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    DatabaseModule,
    AuthModule,
    PatientsModule,
    SessionsModule,
    HealthModule,
    ClinicalProcessesModule,
    BillingModule,
    PortalModule,
    NotificationsModule,
    ResourcesModule,
    MessagesModule,
    DashboardModule,
    ExportsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
