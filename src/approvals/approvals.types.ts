export type Expense = {
  id: string;
  tenant: string;
  owner: string;
  description: string;
  amount_cents: number;
  state: string;
  version: number;
};
