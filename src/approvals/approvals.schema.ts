export const APPROVALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  owner TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  state TEXT NOT NULL CHECK(state IN ('draft','submitted','approved','rejected','paid')),
  version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS expenses_tenant ON expenses(tenant,id);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES expenses(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  at INTEGER NOT NULL,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id),
  key TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  UNIQUE(tenant,key)
);
`;
