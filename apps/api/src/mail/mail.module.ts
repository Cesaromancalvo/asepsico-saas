import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

/** Correo saliente interno. Factoría: lee el entorno una vez al arrancar (sin inyección de env). */
@Module({
  providers: [{ provide: MailService, useFactory: () => new MailService() }],
  exports: [MailService],
})
export class MailModule {}
