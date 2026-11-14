import { Module } from '@nestjs/common';
import { SampleDataController } from './sample-data.controller';
import { SampleDataService } from './sample-data.service';

@Module({ controllers: [SampleDataController], providers: [SampleDataService] })
export class SampleDataModule {}
