import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { randomUUID } from 'node:crypto';
import { Database } from './database';
import { AuthenticatedRequest, JwtGuard, User } from './identity';

export class CreateExpense {
  @ApiProperty({ example: 'Passagem para visita ao cliente' })
  @IsString()
  @MinLength(4)
  @MaxLength(200)
  description!: string;
  @ApiProperty({ example: 15000, description: 'Valor em centavos de BRL' })
  @IsInt()
  @Min(1)
  @Max(1000000000)
  amountCents!: number;
}
export class VersionCommand {
  @ApiProperty({ example: 0 }) @IsInt() @Min(0) version!: number;
}
type Expense = {
  id: string;
  tenant: string;
  owner: string;
  description: string;
  amount_cents: number;
  state: string;
  version: number;
};

@Injectable()
export class Approvals {
  constructor(private readonly db: Database) {
    db.connection.exec(`
      CREATE TABLE IF NOT EXISTS expenses(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,owner TEXT NOT NULL,description TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),state TEXT NOT NULL CHECK(state IN ('draft','submitted','approved','rejected','paid')),version INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS expenses_tenant ON expenses(tenant,id);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,expense_id TEXT NOT NULL REFERENCES expenses(id),actor TEXT NOT NULL,action TEXT NOT NULL,at INTEGER NOT NULL,version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id),key TEXT NOT NULL,amount_cents INTEGER NOT NULL,UNIQUE(tenant,key));
    `);
  }
  private log(
    expenseId: string,
    actor: string,
    action: string,
    version: number,
  ) {
    this.db.connection
      .prepare(
        'INSERT INTO audit(expense_id,actor,action,at,version) VALUES(?,?,?,?,?)',
      )
      .run(expenseId, actor, action, Date.now(), version);
  }
  private expense(user: User, id: string): Expense {
    const row = this.db.connection
      .prepare('SELECT * FROM expenses WHERE tenant=? AND id=?')
      .get(user.tenant, id) as Expense | undefined;
    if (!row) throw new NotFoundException('Solicitação inexistente');
    if (user.role === 'requester' && row.owner !== user.id)
      throw new NotFoundException('Solicitação inexistente');
    return row;
  }
  create(user: User, input: CreateExpense) {
    if (user.role !== 'requester')
      throw new ForbiddenException('Somente solicitante cria despesas');
    return this.db.transaction(() => {
      const id = randomUUID();
      this.db.connection
        .prepare(
          "INSERT INTO expenses(id,tenant,owner,description,amount_cents,state) VALUES(?,?,?,?,?,'draft')",
        )
        .run(id, user.tenant, user.id, input.description, input.amountCents);
      this.log(id, user.id, 'created', 0);
      return this.expense(user, id);
    });
  }
  get(user: User, id: string) {
    const row = this.expense(user, id);
    return {
      ...row,
      currency: 'BRL',
      audit: this.db.connection
        .prepare(
          'SELECT actor,action,at,version FROM audit WHERE expense_id=? ORDER BY id',
        )
        .all(id),
    };
  }
  list(user: User) {
    if (user.role === 'requester')
      return this.db.connection
        .prepare(
          'SELECT * FROM expenses WHERE tenant=? AND owner=? ORDER BY id LIMIT 100',
        )
        .all(user.tenant, user.id);
    return this.db.connection
      .prepare('SELECT * FROM expenses WHERE tenant=? ORDER BY id LIMIT 100')
      .all(user.tenant);
  }
  transition(
    user: User,
    id: string,
    version: number,
    target: 'submitted' | 'approved' | 'rejected',
  ) {
    return this.db.transaction(() => {
      const row = this.expense(user, id);
      if (
        target === 'submitted' &&
        (user.role !== 'requester' || row.owner !== user.id)
      )
        throw new ForbiddenException(
          'Somente o proprietário envia a solicitação',
        );
      if (
        target !== 'submitted' &&
        (user.role !== 'approver' || row.owner === user.id)
      )
        throw new ForbiddenException('Aprovação exige aprovador independente');
      if (row.version !== version)
        throw new ConflictException('Versão desatualizada; consulte novamente');
      const expected = target === 'submitted' ? 'draft' : 'submitted';
      if (row.state !== expected)
        throw new ConflictException(
          `Transição não permitida a partir de ${row.state}`,
        );
      this.db.connection
        .prepare(
          'UPDATE expenses SET state=?,version=version+1 WHERE id=? AND version=?',
        )
        .run(target, id, version);
      this.log(id, user.id, target, version + 1);
      return this.get(user, id);
    });
  }
  pay(user: User, id: string, version: number, key: string | undefined) {
    if (user.role !== 'finance')
      throw new ForbiddenException('Somente financeiro registra pagamento');
    if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw new BadRequestException('Idempotency-Key inválida');
    return this.db.transaction(() => {
      const row = this.expense(user, id);
      const previous = this.db.connection
        .prepare('SELECT * FROM payments WHERE tenant=? AND key=?')
        .get(user.tenant, key);
      if (previous) {
        if (previous.expense_id !== id)
          throw new ConflictException('Chave utilizada em outra despesa');
        return {
          payment: previous,
          expense: this.get(user, id),
          simulated: true,
        };
      }
      if (row.version !== version || row.state !== 'approved')
        throw new ConflictException(
          'Despesa deve estar aprovada com versão atual',
        );
      const paymentId = randomUUID();
      this.db.connection
        .prepare('INSERT INTO payments VALUES(?,?,?,?,?)')
        .run(paymentId, user.tenant, id, key, row.amount_cents);
      this.db.connection
        .prepare(
          "UPDATE expenses SET state='paid',version=version+1 WHERE id=?",
        )
        .run(id);
      this.log(id, user.id, 'payment_recorded', version + 1);
      return {
        payment: this.db.connection
          .prepare('SELECT * FROM payments WHERE id=?')
          .get(paymentId),
        expense: this.get(user, id),
        simulated: true,
      };
    });
  }
}

@ApiTags('Despesas')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('expenses')
export class ApprovalsController {
  constructor(private readonly approvals: Approvals) {}
  @Post() create(
    @Req() request: AuthenticatedRequest,
    @Body() input: CreateExpense,
  ) {
    return this.approvals.create(request.user, input);
  }
  @Get() list(@Req() request: AuthenticatedRequest) {
    return this.approvals.list(request.user);
  }
  @Get(':id') get(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.approvals.get(request.user, id);
  }
  @Post(':id/submit') submit(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: VersionCommand,
  ) {
    return this.approvals.transition(
      request.user,
      id,
      input.version,
      'submitted',
    );
  }
  @Post(':id/approve') approve(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: VersionCommand,
  ) {
    return this.approvals.transition(
      request.user,
      id,
      input.version,
      'approved',
    );
  }
  @Post(':id/reject') reject(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: VersionCommand,
  ) {
    return this.approvals.transition(
      request.user,
      id,
      input.version,
      'rejected',
    );
  }
  @Post(':id/pay') @ApiHeader({ name: 'Idempotency-Key', required: true }) pay(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: VersionCommand,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.approvals.pay(request.user, id, input.version, key);
  }
}
