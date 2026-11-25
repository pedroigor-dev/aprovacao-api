import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { ApprovalsController } from './approvals.controller';
import { Approvals } from './approvals.service';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [ApprovalsController],
  providers: [Approvals],
})
export class ApprovalsModule {}
