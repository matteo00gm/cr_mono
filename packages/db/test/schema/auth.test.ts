import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  authAccounts,
  authSessions,
  authTwoFactor,
  authUsers,
  authVerifications,
} from '../../src/schema/auth.js';
import { memberships } from '../../src/schema/memberships.js';

/**
 * Shape assertions for the Better Auth tables (P0-23a).
 */

const users = getTableConfig(authUsers);
const sessions = getTableConfig(authSessions);
const accounts = getTableConfig(authAccounts);

describe('auth table naming', () => {
  it('prefixes every table, so none is called `user`', () => {
    /*
     * `user` is a reserved word in Postgres — bare `user` is shorthand for
     * CURRENT_USER. Better Auth's default name works only while every
     * reference stays quoted, and the first unquoted use returns the database
     * role instead of failing: a silent wrong answer rather than an error.
     */
    const names = [authUsers, authSessions, authAccounts, authVerifications, authTwoFactor].map(
      (table) => getTableConfig(table).name,
    );

    expect(names).toEqual([
      'auth_users',
      'auth_sessions',
      'auth_accounts',
      'auth_verifications',
      'auth_two_factor',
    ]);
  });
});

describe('auth_users', () => {
  it('keys on text, not uuid', () => {
    // Better Auth issues text ids. Forcing uuid would mean patching its
    // generator or casting at every boundary, and buys nothing.
    const id = users.columns.find((column) => column.name === 'id');

    expect(id?.getSQLType()).toBe('text');
    expect(id?.primary).toBe(true);
  });

  it('makes email unique, since it is the login lookup', () => {
    expect(users.uniqueConstraints.map((c) => c.name)).toContain('auth_users_email_unique');
  });

  it('carries no tenant_id, and cannot', () => {
    /*
     * Authentication happens before a tenant is known — that is why tenant
     * resolution reads memberships afterwards. There is no context to scope a
     * login query by, so these tables have no policy and P0-41 never sees
     * them: it discovers tables *having* a tenant_id.
     */
    expect(users.columns.map((column) => column.name)).not.toContain('tenant_id');
  });
});

describe('auth_sessions', () => {
  it('is unique on token and indexed for the expiry sweep', () => {
    expect(sessions.uniqueConstraints.map((c) => c.name)).toContain('auth_sessions_token_unique');
    expect(sessions.indexes.map((i) => i.config.name)).toContain('auth_sessions_expires_at_idx');
  });

  it('goes with its user', () => {
    // Deleting a user must not leave sessions that authenticate as them.
    const fk = sessions.foreignKeys[0]?.reference();

    expect(getTableConfig(fk?.foreignTable ?? authUsers).name).toBe('auth_users');
    expect(sessions.foreignKeys[0]?.onDelete).toBe('cascade');
  });
});

describe('auth_accounts', () => {
  it('holds the password hash, not auth_users', () => {
    // One row per provider per user, and the credential provider is one of
    // them — which is why the hash lives beside the other providers' tokens.
    expect(accounts.columns.map((column) => column.name)).toContain('password');
    expect(users.columns.map((column) => column.name)).not.toContain('password');
  });

  it('refuses the same provider account twice', () => {
    expect(accounts.uniqueConstraints.map((c) => c.name)).toContain(
      'auth_accounts_provider_account_unique',
    );
  });
});

describe('memberships.user_id', () => {
  it('finally references auth_users', () => {
    /*
     * The foreign key that motivated P0-23a. Until now `user_id` was text
     * pointing at nothing, so a membership could name a user who had never
     * existed and nothing would object.
     */
    const config = getTableConfig(memberships);
    const targets = config.foreignKeys.map(
      (fk) => getTableConfig(fk.reference().foreignTable).name,
    );

    expect(targets).toContain('auth_users');
  });

  it('cascades, so deleting a user removes their memberships', () => {
    const config = getTableConfig(memberships);
    const userFk = config.foreignKeys.find(
      (fk) => getTableConfig(fk.reference().foreignTable).name === 'auth_users',
    );

    expect(userFk?.onDelete).toBe('cascade');
  });
});
