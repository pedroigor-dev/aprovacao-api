import { APPROVALS_SCHEMA } from './approvals.schema';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Database } from '../database/database.service';
import { User } from '../identity/identity.types';
import { CreateExpense } from './approvals.dto';
import { Expense } from './approvals.types';

@Injectable()
export class Approvals {
  constructor(private readonly db: Database) {
    db.connection.exec(APPROVALS_SCHEMA);
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
    if (!row) {
      throw new NotFoundException('Solicitação inexistente');
    }
    if (user.role === 'requester' && row.owner !== user.id) {
      throw new NotFoundException('Solicitação inexistente');
    }
    return row;
  }

  create(user: User, input: CreateExpense) {
    if (user.role !== 'requester') {
      throw new ForbiddenException('Somente solicitante cria despesas');
    }
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
    if (user.role === 'requester') {
      return this.db.connection
        .prepare(
          'SELECT * FROM expenses WHERE tenant=? AND owner=? ORDER BY id LIMIT 100',
        )
        .all(user.tenant, user.id);
    }
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
      ) {
        throw new ForbiddenException(
          'Somente o proprietário envia a solicitação',
        );
      }
      if (
        target !== 'submitted' &&
        (user.role !== 'approver' || row.owner === user.id)
      ) {
        throw new ForbiddenException('Aprovação exige aprovador independente');
      }
      if (row.version !== version) {
        throw new ConflictException('Versão desatualizada; consulte novamente');
      }
      const expected = target === 'submitted' ? 'draft' : 'submitted';
      if (row.state !== expected) {
        throw new ConflictException(
          `Transição não permitida a partir de ${row.state}`,
        );
      }
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
    if (user.role !== 'finance') {
      throw new ForbiddenException('Somente financeiro registra pagamento');
    }
    if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key inválida');
    }
    return this.db.transaction(() => {
      const row = this.expense(user, id);
      const previous = this.db.connection
        .prepare('SELECT * FROM payments WHERE tenant=? AND key=?')
        .get(user.tenant, key);
      if (previous) {
        if (previous.expense_id !== id) {
          throw new ConflictException('Chave utilizada em outra despesa');
        }
        return {
          payment: previous,
          expense: this.get(user, id),
          simulated: true,
        };
      }
      if (row.version !== version || row.state !== 'approved') {
        throw new ConflictException(
          'Despesa deve estar aprovada com versão atual',
        );
      }
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
