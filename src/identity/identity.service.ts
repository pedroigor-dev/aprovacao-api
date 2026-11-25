import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Database } from '../database/database.service';
import { Login, ProvisionUser } from './identity.dto';
import { IDENTITY_SCHEMA } from './identity.schema';
import { User } from './identity.types';

const derivePasswordKey = promisify(scrypt);

@Injectable()
export class Identity {
  private readonly loginAttempts = new Map<
    string,
    {
      count: number;
      until: number;
    }
  >();

  constructor(private readonly db: Database) {
    db.connection.exec(IDENTITY_SCHEMA);
  }

  async provision(input: ProvisionUser, key: string | undefined) {
    const expected = Buffer.from(process.env.BOOTSTRAP_KEY!);
    const supplied = Buffer.from(key ?? '');
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    ) {
      throw new UnauthorizedException('Chave administrativa inválida');
    }
    const email = input.email.toLowerCase();
    const salt = randomBytes(16).toString('hex');
    const digest = (
      (await derivePasswordKey(input.password, salt, 64)) as Buffer
    ).toString('hex');
    return this.db.transaction(() => {
      if (
        this.db.connection
          .prepare('SELECT id FROM users WHERE tenant=? AND email=?')
          .get(input.tenant, email)
      ) {
        throw new ConflictException('Usuário já cadastrado nesta empresa');
      }
      const id = randomUUID();
      this.db.connection
        .prepare('INSERT INTO users VALUES(?,?,?,?,?,?)')
        .run(id, input.tenant, email, input.role, salt, digest);
      return { id, tenant: input.tenant, email, role: input.role };
    });
  }

  async login(input: Login, ip: string) {
    const now = Date.now();
    for (const [key, attempt] of this.loginAttempts) {
      if (attempt.until <= now) {
        this.loginAttempts.delete(key);
      }
    }
    if (this.loginAttempts.size >= 5000 && !this.loginAttempts.has(ip)) {
      throw new HttpException(
        'Muitas tentativas; aguarde',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const attempts = this.loginAttempts.get(ip) ?? {
      count: 0,
      until: now + 60000,
    };
    attempts.count++;
    this.loginAttempts.set(ip, attempts);
    if (attempts.count > 10) {
      throw new HttpException(
        'Limite de login atingido; aguarde um minuto',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const row = this.db.connection
      .prepare('SELECT * FROM users WHERE tenant=? AND email=?')
      .get(input.tenant, input.email.toLowerCase());
    const calculated = (await derivePasswordKey(
      input.password,
      String(row?.salt ?? 'invalid-user-salt'),
      64,
    )) as Buffer;
    const expected = row
      ? Buffer.from(String(row.digest), 'hex')
      : Buffer.alloc(64);
    if (!row || !timingSafeEqual(calculated, expected)) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
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
      if (typeof claims === 'string' || typeof claims.sub !== 'string') {
        throw new Error();
      }
      const row = this.db.connection
        .prepare('SELECT id,tenant,email,role FROM users WHERE id=?')
        .get(claims.sub);
      if (!row || row.tenant !== claims.tenant) {
        throw new Error();
      }
      return row as User;
    } catch {
      throw new UnauthorizedException('Token inválido ou expirado');
    }
  }
}
