import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Identity } from './identity.service';
import { AuthenticatedRequest } from './identity.types';

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly identity: Identity) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const value = request.headers.authorization;
    if (!value?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token obrigatório');
    }
    request.user = this.identity.authenticate(value.slice(7));
    return true;
  }
}
