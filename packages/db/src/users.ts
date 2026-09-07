import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * The one read of `auth_users` the application makes for itself (P0-51).
 *
 * Better Auth owns this table and every other access to it goes through the
 * adapter. This exists because invitation acceptance has to compare the
 * invited address against the accepting user's, and doing that comparison
 * inside the acceptance transaction is what keeps it atomic with the
 * membership write.
 *
 * Returns `undefined` for a user id with no row, which in practice means a
 * session for an account deleted between sign-in and this request.
 */
export const readUserEmail = async (
  tx: DbTransaction,
  userId: string,
): Promise<string | undefined> => {
  const rows = await tx.execute(sql`SELECT email FROM auth_users WHERE id = ${userId}`);
  const row = [...rows][0] as { email?: string } | undefined;

  return row?.email;
};
