const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = 'http://127.0.0.1:' + process.env.PORT;
async function call(path, body, headers = {}) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.API_KEY ?? '',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(JSON.stringify({ status: response.status, result }));
  return result;
}
async function main() {
  const tenant = 'demo-' + crypto.randomUUID();
  const tokens = {};
  for (const role of ['requester', 'approver', 'finance', 'auditor']) {
    const credentials = {
      tenant,
      email: role + '@example.com',
      password: 'Demo-' + crypto.randomUUID(),
    };
    await call(
      '/identity/users',
      { ...credentials, role },
      { 'X-Bootstrap-Key': process.env.BOOTSTRAP_KEY },
    );
    tokens[role] = (await call('/identity/login', credentials)).accessToken;
  }
  const auth = (role) => ({ Authorization: 'Bearer ' + tokens[role] });
  const item = await call(
    '/expenses',
    { description: 'Passagem para visita ao cliente', amountCents: 15000 },
    auth('requester'),
  );
  await call(
    '/expenses/' + item.id + '/submit',
    { version: 0 },
    auth('requester'),
  );
  await call(
    '/expenses/' + item.id + '/approve',
    { version: 1 },
    auth('approver'),
  );
  const result = await call(
    '/expenses/' + item.id + '/pay',
    { version: 2 },
    { ...auth('finance'), 'Idempotency-Key': crypto.randomUUID() },
  );
  assert.equal(result.expense.state, 'paid');
  console.log(
    JSON.stringify(
      await call('/expenses/' + item.id, undefined, auth('auditor')),
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
