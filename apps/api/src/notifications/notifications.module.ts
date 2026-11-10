import { Module } from '@nestjs/common';
import { PortalModule } from '../portal/portal.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationMailer } from './email/notification-mailer';
import { EmailOutboxService } from './email/email-outbox.service';
import { EmailOutboxScheduler } from './email/email-outbox.scheduler';

@Module({
  imports: [PortalModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    // Factoría: lee el entorno una vez al arrancar (interruptores, remitentes, SMTP).
    { provide: NotificationMailer, useFactory: () => new NotificationMailer() },
    EmailOutboxService,
    EmailOutboxScheduler,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
