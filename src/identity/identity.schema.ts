export const IDENTITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  salt TEXT NOT NULL,
  digest TEXT NOT NULL,
  UNIQUE(tenant,email)
);
`;
