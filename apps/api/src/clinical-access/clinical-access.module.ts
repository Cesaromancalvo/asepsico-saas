import { Global, Module } from '@nestjs/common';
import { ClinicalAccessService } from './clinical-access.service';

/** Global: todos los módulos con contenido clínico deciden el acceso con el mismo servicio. */
@Global()
@Module({ providers: [ClinicalAccessService], exports: [ClinicalAccessService] })
export class ClinicalAccessModule {}
