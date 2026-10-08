export const roles = ['customer', 'admin'] as const;
export type Role = (typeof roles)[number];

/** The authenticated caller of a request. */
export interface Principal {
  userId: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: Principal;
    }
  }
}
