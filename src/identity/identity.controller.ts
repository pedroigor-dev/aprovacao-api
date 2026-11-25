import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { ApiHeader, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Login, ProvisionUser } from './identity.dto';
import { Identity } from './identity.service';

@ApiTags('Identidade')
@Controller('identity')
export class IdentityController {
  constructor(private readonly identity: Identity) {}

  @Post('users')
  @ApiSecurity('bootstrap')
  @ApiHeader({ name: 'X-Bootstrap-Key', required: true })
  provision(
    @Body()
    body: ProvisionUser,
    @Headers('x-bootstrap-key')
    key: string | undefined,
  ) {
    return this.identity.provision(body, key);
  }

  @Post('login')
  login(
    @Body()
    body: Login,
    @Req()
    request: Request,
  ) {
    return this.identity.login(
      body,
      request.ip ?? request.socket.remoteAddress ?? 'unknown',
    );
  }
}
