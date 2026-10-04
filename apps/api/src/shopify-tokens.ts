import {
  DeleteParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  type SSMClient,
} from '@aws-sdk/client-ssm';

/**
 * Where a shop's offline token lives (P6-06, ADR 0031): SSM Parameter Store,
 * encrypted, one parameter per winery and shop — never the database.
 *
 * The token reads a seller's catalogue and orders for as long as the app is
 * installed, so it is held where only the API's own role can read it, under
 * one path, and removed the moment Shopify says the app is gone.
 */
export interface ShopifyTokenStore {
  readonly put: (tenantId: string, shop: string, token: string) => Promise<void>;
  /** Idempotent: a token already gone is the state asked for. */
  readonly remove: (tenantId: string, shop: string) => Promise<void>;
}

/** The parameter's name: under the stage's prefix, by winery, then shop. */
export const tokenParameter = (prefix: string, tenantId: string, shop: string): string =>
  `${prefix.replace(/\/+$/u, '')}/${tenantId}/${shop}`;

/** The deployed store: a `SecureString`, overwritten on a reinstall, deleted on uninstall. */
export const ssmShopifyTokens = ({
  client,
  prefix,
}: {
  readonly client: Pick<SSMClient, 'send'>;
  /** `/sommelier/<stage>/shopify`: the one path the API role may write. */
  readonly prefix: string;
}): ShopifyTokenStore => ({
  put: async (tenantId, shop, token) => {
    await client.send(
      new PutParameterCommand({
        Name: tokenParameter(prefix, tenantId, shop),
        Value: token,
        Type: 'SecureString',
        Overwrite: true,
      }),
    );
  },
  remove: async (tenantId, shop) => {
    try {
      await client.send(
        new DeleteParameterCommand({ Name: tokenParameter(prefix, tenantId, shop) }),
      );
    } catch (error) {
      if (!(error instanceof ParameterNotFound)) throw error;
    }
  },
});

/**
 * A store for a local run, where there is no SSM: the tokens live in the
 * process and are gone when it stops. Readable, so a test can see what was
 * put — the deployed store deliberately is not.
 */
export const memoryShopifyTokens = (): ShopifyTokenStore & {
  readonly read: (tenantId: string, shop: string) => string | undefined;
} => {
  const tokens = new Map<string, string>();
  const key = (tenantId: string, shop: string) => `${tenantId}/${shop}`;

  return {
    put: (tenantId, shop, token) => {
      tokens.set(key(tenantId, shop), token);
      return Promise.resolve();
    },
    remove: (tenantId, shop) => {
      tokens.delete(key(tenantId, shop));
      return Promise.resolve();
    },
    read: (tenantId, shop) => tokens.get(key(tenantId, shop)),
  };
};
