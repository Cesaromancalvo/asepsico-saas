import { Module } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { MailModule } from '../mail/mail.module';
import { MailService } from '../mail/mail.service';
import { WaitlistNotifier } from './waitlist-notifier';
import { WaitlistController } from './waitlist.controller';
import { WaitlistOriginGuard } from './waitlist-origin.guard';
import { WaitlistService } from './waitlist.service';

@Module({
  imports: [MailModule],
  controllers: [WaitlistController],
  providers: [
    WaitlistService,
    WaitlistOriginGuard,
    { provide: WaitlistNotifier, useFactory: (prisma: PrismaService, mail: MailService) => new WaitlistNotifier(prisma, mail), inject: [PrismaService, MailService] },
  ],
})
export class WaitlistModule {}
