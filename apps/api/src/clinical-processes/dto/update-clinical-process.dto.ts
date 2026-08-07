import { PartialType } from '@nestjs/swagger';
import { CreateClinicalProcessDto } from './create-clinical-process.dto';

export class UpdateClinicalProcessDto extends PartialType(
  CreateClinicalProcessDto,
) {}
