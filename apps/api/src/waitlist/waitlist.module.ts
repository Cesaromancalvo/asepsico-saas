import { Module } from '@nestjs/common';
import { WaitlistController } from './waitlist.controller';
import { WaitlistOriginGuard } from './waitlist-origin.guard';
import { WaitlistService } from './waitlist.service';

@Module({ controllers: [WaitlistController], providers: [WaitlistService, WaitlistOriginGuard] })
export class WaitlistModule {}
