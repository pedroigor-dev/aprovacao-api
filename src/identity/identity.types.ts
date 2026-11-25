import { Request } from 'express';

export type User = {
  id: string;
  tenant: string;
  email: string;
  role: 'requester' | 'approver' | 'finance' | 'auditor';
};

export type AuthenticatedRequest = Request & {
  user: User;
};
