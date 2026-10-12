import { Injectable } from '@nestjs/common';
import { ClinicalAccessService } from '../clinical-access/clinical-access.service';

/**
 * Alias del servicio central de acceso clínico para el módulo Patients. Toda la decisión vive en
 * ClinicalAccessService (un único punto, falla en cerrado); aquí no se añade lógica propia.
 */
@Injectable()
export class PatientAccessService extends ClinicalAccessService {}
