import {
  Body,
  CanActivate,
  ConflictException,
  Controller,
  ExecutionContext,
  Headers,
  HttpException,
  HttpStatus,
  Injectable,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Database } from './database';
import { Request } from 'express';

export type User = {
  id: string;
  tenant: string;
  email: string;
  role: 'requester' | 'approver' | 'finance' | 'auditor';
};
export type AuthenticatedRequest = Request & { user: User };
export class Login {
  @ApiProperty({ example: 'empresa-a' })
  @Matches(/^[a-z0-9-]{2,50}$/)
  tenant!: string;
  @ApiProperty({ example: 'ana@example.com' })
  @IsEmail()
  @MaxLength(180)
  email!: string;
  @ApiProperty({ minLength: 12, example: 'Senha-local-segura-123!' })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}
export class ProvisionUser extends Login {
  @ApiProperty({ enum: ['requester', 'approver', 'finance', 'auditor'] })
  @IsIn(['requester', 'approver', 'finance', 'auditor'])
  role!: User['role'];
}

@Injectable()
export class Identity {
  private readonly loginAttempts = new Map<
    string,
    { count: number; until: number }
  >();
  constructor(private readonly db: Database) {
    db.connection.exec(
      'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,email TEXT NOT NULL,role TEXT NOT NULL,salt TEXT NOT NULL,digest TEXT NOT NULL,UNIQUE(tenant,email));',
    );
  }
  provision(input: ProvisionUser, key: string | undefined) {
    const expected = Buffer.from(process.env.BOOTSTRAP_KEY!),
      supplied = Buffer.from(key ?? '');
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      throw new UnauthorizedException('Chave administrativa inválida');
    const email = input.email.toLowerCase();
    const salt = randomBytes(16).toString('hex'),
      digest = scryptSync(input.password, salt, 64).toString('hex');
    return this.db.transaction(() => {
      if (
        this.db.connection
          .prepare('SELECT id FROM users WHERE tenant=? AND email=?')
          .get(input.tenant, email)
      )
        throw new ConflictException('Usuário já cadastrado nesta empresa');
      const id = randomUUID();
      this.db.connection
        .prepare('INSERT INTO users VALUES(?,?,?,?,?,?)')
        .run(id, input.tenant, email, input.role, salt, digest);
      return { id, tenant: input.tenant, email, role: input.role };
    });
  }
  login(input: Login, ip: string) {
    const now = Date.now();
    for (const [key, attempt] of this.loginAttempts)
      if (attempt.until <= now) this.loginAttempts.delete(key);
    if (this.loginAttempts.size >= 5000 && !this.loginAttempts.has(ip))
      throw new HttpException(
        'Muitas tentativas; aguarde',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const attempts = this.loginAttempts.get(ip) ?? {
      count: 0,
      until: now + 60000,
    };
    attempts.count++;
    this.loginAttempts.set(ip, attempts);
    if (attempts.count > 10)
      throw new HttpException(
        'Limite de login atingido; aguarde um minuto',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const row = this.db.connection
      .prepare('SELECT * FROM users WHERE tenant=? AND email=?')
      .get(input.tenant, input.email.toLowerCase());
    const calculated = scryptSync(
      input.password,
      String(row?.salt ?? 'invalid-user-salt'),
      64,
    );
    const expected = row
      ? Buffer.from(String(row.digest), 'hex')
      : Buffer.alloc(64);
    if (!row || !timingSafeEqual(calculated, expected))
      throw new UnauthorizedException('Credenciais inválidas');
    const token = jwt.sign({ tenant: row.tenant }, process.env.JWT_SECRET!, {
      algorithm: 'HS256',
      subject: String(row.id),
      issuer: 'aprovacao-api',
      audience: 'aprovacao-client',
      expiresIn: '1h',
    });
    return { accessToken: token, tokenType: 'Bearer', expiresIn: 3600 };
  }
  authenticate(token: string): User {
    try {
      const claims = jwt.verify(token, process.env.JWT_SECRET!, {
        algorithms: ['HS256'],
        issuer: 'aprovacao-api',
        audience: 'aprovacao-client',
      });
      if (typeof claims === 'string' || typeof claims.sub !== 'string')
        throw new Error();
      const row = this.db.connection
        .prepare('SELECT id,tenant,email,role FROM users WHERE id=?')
        .get(claims.sub);
      if (!row || row.tenant !== claims.tenant) throw new Error();
      return row as User;
    } catch {
      throw new UnauthorizedException('Token inválido ou expirado');
    }
  }
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly identity: Identity) {}
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const value = request.headers.authorization;
    if (!value?.startsWith('Bearer '))
      throw new UnauthorizedException('Bearer token obrigatório');
    request.user = this.identity.authenticate(value.slice(7));
    return true;
  }
}

@ApiTags('Identidade')
@Controller('identity')
export class IdentityController {
  constructor(private readonly identity: Identity) {}
  @Post('users')
  @ApiSecurity('bootstrap')
  @ApiHeader({ name: 'X-Bootstrap-Key', required: true })
  provision(
    @Body() body: ProvisionUser,
    @Headers('x-bootstrap-key') key: string | undefined,
  ) {
    return this.identity.provision(body, key);
  }
  @Post('login') login(@Body() body: Login, @Req() request: Request) {
    return this.identity.login(
      body,
      request.ip ?? request.socket.remoteAddress ?? 'unknown',
    );
  }
}
