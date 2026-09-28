import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { FieldEncryptionCheckService } from '../common/crypto/field-encryption-check.service';
@Global() @Module({ providers: [PrismaService, FieldEncryptionCheckService], exports: [PrismaService] })
export class DatabaseModule {}
