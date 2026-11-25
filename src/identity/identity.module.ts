import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IdentityController } from './identity.controller';
import { Identity } from './identity.service';
import { JwtGuard } from './jwt.guard';

@Module({
  imports: [DatabaseModule],
  controllers: [IdentityController],
  providers: [Identity, JwtGuard],
  exports: [Identity, JwtGuard],
})
export class IdentityModule {}
