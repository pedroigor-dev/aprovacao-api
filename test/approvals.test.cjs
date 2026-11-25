const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const jwt = require('jsonwebtoken');
const { createApplication } = require('../dist/app');
const { Database } = require('../dist/database');
const folder = mkdtempSync(join(tmpdir(), 'approvals-'));
process.env.JWT_SECRET = 'jwt-test-secret-with-more-than-32-characters';
process.env.BOOTSTRAP_KEY = 'bootstrap-test-key-with-more-than-32-characters';
process.env.DATABASE_PATH = join(folder, 'approvals.sqlite');
let app, url;
const accounts = {};
async function request(path, body, token, extraHeaders = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (token) headers.authorization = 'Bearer ' + token;
  const response = await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function expense() {
  return (
    await request(
      '/expenses',
      { description: 'Viagem para atendimento de cliente', amountCents: 15000 },
      accounts.requester.token,
    )
  ).body;
}
before(async () => {
  app = await createApplication();
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
  for (const [name, role, tenant] of [
    ['requester', 'requester', 'empresa-a'],
    ['approver', 'approver', 'empresa-a'],
    ['finance', 'finance', 'empresa-a'],
    ['auditor', 'auditor', 'empresa-a'],
    ['outsider', 'approver', 'empresa-b'],
    ['colleague', 'requester', 'empresa-a'],
  ]) {
    const input = {
      tenant,
      email: name + '@example.com',
      password: 'Local-password-123!',
      role,
    };
    const provisioned = await request('/identity/users', input, undefined, {
      'x-bootstrap-key': process.env.BOOTSTRAP_KEY,
    });
    assert.equal(provisioned.status, 201);
    const { role: ignored, ...login } = input;
    const result = await request('/identity/login', login);
    assert.equal(result.status, 201);
    accounts[name] = { ...provisioned.body, token: result.body.accessToken };
  }
});
after(async () => {
  await app?.close();
  rmSync(folder, { recursive: true, force: true });
});

test('cadastro exige chave administrativa e valida senha e campos extras', async () => {
  const user = {
    tenant: 'empresa-a',
    email: 'new@example.com',
    password: 'Local-password-123!',
    role: 'requester',
  };
  assert.equal((await request('/identity/users', user)).status, 401);
  assert.equal(
    (
      await request(
        '/identity/users',
        { ...user, password: 'short' },
        undefined,
        { 'x-bootstrap-key': process.env.BOOTSTRAP_KEY },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        '/expenses',
        { description: 'Despesa', amountCents: 100, tenant: 'empresa-b' },
        accounts.requester.token,
      )
    ).status,
    400,
  );
});
test('tokens expirados e assinatura inválida não dão acesso', async () => {
  assert.equal(
    (await request('/expenses', undefined, 'invalid.token.value')).status,
    401,
  );
  const expired = jwt.sign({ tenant: 'empresa-a' }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: accounts.requester.id,
    issuer: 'aprovacao-api',
    audience: 'aprovacao-client',
    expiresIn: -10,
  });
  assert.equal((await request('/expenses', undefined, expired)).status, 401);
  assert.equal((await request('/expenses')).status, 401);
});
test('isolamento entre empresas e entre solicitantes bloqueia acesso direto por ID', async () => {
  const item = await expense();
  assert.equal(
    (await request('/expenses/' + item.id, undefined, accounts.outsider.token))
      .status,
    404,
  );
  assert.equal(
    (await request('/expenses/' + item.id, undefined, accounts.colleague.token))
      .status,
    404,
  );
  const externalList = await request(
    '/expenses',
    undefined,
    accounts.outsider.token,
  );
  assert.deepEqual(externalList.body, []);
  assert.equal(
    (await request('/expenses/' + item.id, undefined, accounts.auditor.token))
      .status,
    200,
  );
});
test('transições exigem papel e versão atual e mantêm auditoria', async () => {
  const item = await expense();
  assert.equal(
    (
      await request(
        `/expenses/${item.id}/approve`,
        { version: 0 },
        accounts.requester.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        `/expenses/${item.id}/submit`,
        { version: 0 },
        accounts.requester.token,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        `/expenses/${item.id}/approve`,
        { version: 0 },
        accounts.approver.token,
      )
    ).status,
    409,
  );
  const results = await Promise.all([
    request(
      `/expenses/${item.id}/approve`,
      { version: 1 },
      accounts.approver.token,
    ),
    request(
      `/expenses/${item.id}/reject`,
      { version: 1 },
      accounts.approver.token,
    ),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [201, 409]);
  const view = (
    await request('/expenses/' + item.id, undefined, accounts.auditor.token)
  ).body;
  assert.equal(view.version, 2);
  assert.equal(view.audit.length, 3);
  assert.ok(['approved', 'rejected'].includes(view.state));
});
test('autoaprovação é proibida mesmo com papel de aprovador', async () => {
  const item = await expense();
  await request(
    `/expenses/${item.id}/submit`,
    { version: 0 },
    accounts.requester.token,
  );
  app
    .get(Database)
    .connection.prepare('UPDATE expenses SET owner=? WHERE id=?')
    .run(accounts.approver.id, item.id);
  assert.equal(
    (
      await request(
        `/expenses/${item.id}/approve`,
        { version: 1 },
        accounts.approver.token,
      )
    ).status,
    403,
  );
});
test('registro financeiro é atômico e idempotente; auditor não pode pagar', async () => {
  const item = await expense();
  await request(
    `/expenses/${item.id}/submit`,
    { version: 0 },
    accounts.requester.token,
  );
  await request(
    `/expenses/${item.id}/approve`,
    { version: 1 },
    accounts.approver.token,
  );
  assert.equal(
    (
      await request(
        `/expenses/${item.id}/pay`,
        { version: 2 },
        accounts.auditor.token,
        { 'idempotency-key': 'payment-key-1' },
      )
    ).status,
    403,
  );
  const first = await request(
    `/expenses/${item.id}/pay`,
    { version: 2 },
    accounts.finance.token,
    { 'idempotency-key': 'payment-key-1' },
  );
  const again = await request(
    `/expenses/${item.id}/pay`,
    { version: 2 },
    accounts.finance.token,
    { 'idempotency-key': 'payment-key-1' },
  );
  assert.equal(first.body.payment.id, again.body.payment.id);
  assert.equal(again.body.expense.state, 'paid');
  assert.equal(again.body.expense.version, 3);
  assert.equal(
    again.body.expense.audit.filter((x) => x.action === 'payment_recorded')
      .length,
    1,
  );
  assert.equal(
    (
      await request(
        `/expenses/${item.id}/pay`,
        { version: 3 },
        accounts.finance.token,
        { 'idempotency-key': 'payment-key-2' },
      )
    ).status,
    409,
  );
});
test('rejeição é terminal e valor fracionário em centavos é rejeitado', async () => {
  assert.equal(
    (
      await request(
        '/expenses',
        { description: 'Despesa', amountCents: 1.5 },
        accounts.requester.token,
      )
    ).status,
    400,
  );
  const item = await expense();
  await request(
    `/expenses/${item.id}/submit`,
    { version: 0 },
    accounts.requester.token,
  );
  await request(
    `/expenses/${item.id}/reject`,
    { version: 1 },
    accounts.approver.token,
  );
  assert.equal(
    (
      await request(
        `/expenses/${item.id}/approve`,
        { version: 2 },
        accounts.approver.token,
      )
    ).status,
    409,
  );
});
test('dados e token válido continuam utilizáveis após reinício', async () => {
  const item = await expense();
  await app.close();
  app = await createApplication();
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
  assert.equal(
    (await request('/expenses/' + item.id, undefined, accounts.requester.token))
      .body.amount_cents,
    15000,
  );
  const stored = app
    .get(Database)
    .connection.prepare('SELECT digest FROM users WHERE id=?')
    .get(accounts.requester.id);
  assert.notEqual(stored.digest, 'Local-password-123!');
});
test('login tem limite por IP e não confia em X-Forwarded-For', async () => {
  let last;
  for (let i = 0; i < 12; i++)
    last = await request(
      '/identity/login',
      {
        tenant: 'empresa-a',
        email: 'fake@example.com',
        password: 'Wrong-password-123!',
      },
      undefined,
      { 'x-forwarded-for': '123.4.5.' + i },
    );
  assert.equal(last.status, 429);
});
