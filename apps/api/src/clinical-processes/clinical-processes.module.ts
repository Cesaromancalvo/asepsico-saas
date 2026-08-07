import { Module } from '@nestjs/common';
import { ClinicalProcessesController } from './clinical-processes.controller';
import { ClinicalProcessesService } from './clinical-processes.service';

@Module({
  controllers: [ClinicalProcessesController],
  providers: [ClinicalProcessesService],
})
export class ClinicalProcessesModule {}
