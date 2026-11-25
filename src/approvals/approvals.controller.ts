import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AuthenticatedRequest } from '../identity/identity.types';
import { JwtGuard } from '../identity/jwt.guard';
import { CreateExpense, VersionCommand } from './approvals.dto';
import { Approvals } from './approvals.service';

@ApiTags('Despesas')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('expenses')
export class ApprovalsController {
  constructor(private readonly approvals: Approvals) {}

  @Post()
  create(
    @Req()
    request: AuthenticatedRequest,
    @Body()
    input: CreateExpense,
  ) {
    return this.approvals.create(request.user, input);
  }

  @Get()
  list(
    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.approvals.list(request.user);
  }

  @Get(':id')
  get(
    @Req()
    request: AuthenticatedRequest,
    @Param('id')
    id: string,
  ) {
    return this.approvals.get(request.user, id);
  }

  @Post(':id/submit')
  submit(
    @Req()
    request: AuthenticatedRequest,
    @Param('id')
    id: string,
    @Body()
    input: VersionCommand,
  ) {
    return this.approvals.transition(
      request.user,
      id,
      input.version,
      'submitted',
    );
  }

  @Post(':id/approve')
  approve(
    @Req()
    request: AuthenticatedRequest,
    @Param('id')
    id: string,
    @Body()
    input: VersionCommand,
  ) {
    return this.approvals.transition(
      request.user,
      id,
      input.version,
      'approved',
    );
  }

  @Post(':id/reject')
  reject(
    @Req()
    request: AuthenticatedRequest,
    @Param('id')
    id: string,
    @Body()
    input: VersionCommand,
  ) {
    return this.approvals.transition(
      request.user,
      id,
      input.version,
      'rejected',
    );
  }

  @Post(':id/pay')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  pay(
    @Req()
    request: AuthenticatedRequest,
    @Param('id')
    id: string,
    @Body()
    input: VersionCommand,
    @Headers('idempotency-key')
    key: string | undefined,
  ) {
    return this.approvals.pay(request.user, id, input.version, key);
  }
}
