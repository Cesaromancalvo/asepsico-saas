import { Module } from '@nestjs/common';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';
import { PatientCoreService } from './patient-core.service';
import { PatientLifecycleService } from './patient-lifecycle.service';
import { PatientAccessService } from './patient-access.service';
import { PatientCareService } from './patient-care.service';
import { PatientTasksService } from './patient-tasks.service';
import { PatientAssessmentsService } from './patient-assessments.service';
import { PatientRecordsService } from './patient-records.service';
import { ExceptionalAccessController } from './exceptional-access.controller';

@Module({
  controllers: [PatientsController, ExceptionalAccessController],
  providers: [
    PatientAccessService,
    PatientCareService,
    PatientTasksService,
    PatientAssessmentsService,
    PatientRecordsService,
    PatientCoreService,
    PatientLifecycleService,
    PatientsService,
  ],
  exports: [PatientsService],
})
export class PatientsModule {}
