import { Module } from '@nestjs/common';
import { ApprovalsModule } from './approvals/approvals.module';
import { HealthController } from './health/health.controller';

@Module({ imports: [ApprovalsModule], controllers: [HealthController] })
export class AppModule {}
