import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { PatientAgendaService } from './patient-agenda.service';

@Module({ controllers: [SessionsController], providers: [SessionsService, PatientAgendaService], exports: [SessionsService] })
export class SessionsModule {}
