import { Module } from '@nestjs/common';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';
import { PatientAccessService } from './patient-access.service';
import { PatientCareService } from './patient-care.service';
import { PatientTasksService } from './patient-tasks.service';
import { PatientAssessmentsService } from './patient-assessments.service';
import { PatientRecordsService } from './patient-records.service';

@Module({
  controllers: [PatientsController],
  providers: [
    PatientAccessService,
    PatientCareService,
    PatientTasksService,
    PatientAssessmentsService,
    PatientRecordsService,
    PatientsService,
  ],
  exports: [PatientsService],
})
export class PatientsModule {}
