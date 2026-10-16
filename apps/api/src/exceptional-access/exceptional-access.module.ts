import { Module } from '@nestjs/common';
import { ExceptionalAccessController } from './exceptional-access.controller';
import { ExceptionalAccessService } from './exceptional-access.service';
import { ExceptionalAccessRegisterService } from './exceptional-access-register.service';

@Module({
  controllers: [ExceptionalAccessController],
  providers: [ExceptionalAccessService, ExceptionalAccessRegisterService],
  exports: [ExceptionalAccessRegisterService],
})
export class ExceptionalAccessModule {}
