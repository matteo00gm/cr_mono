import {
  DeleteParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';

import { memoryShopifyTokens, ssmShopifyTokens, tokenParameter } from '../src/shopify-tokens.js';

/**
 * Where a shop's token lives (P6-06, ADR 0031): one encrypted parameter per
 * winery and shop, overwritten on a reinstall, gone on an uninstall.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const SHOP = 'cantina-rossi.myshopify.com';

const sending = (fail?: Error) => {
  const send = vi.fn<(command: unknown) => Promise<unknown>>(() =>
    fail === undefined ? Promise.resolve({}) : Promise.reject(fail),
  );

  return { send, client: { send } as never };
};

describe('the parameter', () => {
  it('is under the stage’s prefix, by winery and then shop', () => {
    expect(tokenParameter('/sommelier/dev/shopify', TENANT, SHOP)).toBe(
      `/sommelier/dev/shopify/${TENANT}/${SHOP}`,
    );
    expect(tokenParameter('/sommelier/dev/shopify//', TENANT, SHOP)).toBe(
      `/sommelier/dev/shopify/${TENANT}/${SHOP}`,
    );
  });
});

describe('the SSM store', () => {
  it('puts the token encrypted, replacing one from an earlier install', async () => {
    const { send, client } = sending();

    await ssmShopifyTokens({ client, prefix: '/p' }).put(TENANT, SHOP, 'token-1');

    const [command] = send.mock.calls[0] ?? [];

    expect(command).toBeInstanceOf(PutParameterCommand);
    expect((command as PutParameterCommand).input).toEqual({
      Name: `/p/${TENANT}/${SHOP}`,
      Value: 'token-1',
      Type: 'SecureString',
      Overwrite: true,
    });
  });

  it('deletes it on uninstall', async () => {
    const { send, client } = sending();

    await ssmShopifyTokens({ client, prefix: '/p' }).remove(TENANT, SHOP);

    const [command] = send.mock.calls[0] ?? [];

    expect(command).toBeInstanceOf(DeleteParameterCommand);
    expect((command as DeleteParameterCommand).input).toEqual({ Name: `/p/${TENANT}/${SHOP}` });
  });

  it('treats a token already gone as removed', async () => {
    const { client } = sending(new ParameterNotFound({ message: 'gone', $metadata: {} }));

    await expect(ssmShopifyTokens({ client, prefix: '/p' }).remove(TENANT, SHOP)).resolves.toBe(
      undefined,
    );
  });

  it('lets any other failure through, so an uninstall that did not happen is not reported as one', async () => {
    const { client } = sending(new Error('throttled'));

    await expect(ssmShopifyTokens({ client, prefix: '/p' }).remove(TENANT, SHOP)).rejects.toThrow(
      'throttled',
    );
  });
});

describe('the memory store', () => {
  it('holds a token per winery and shop until it is removed', async () => {
    const store = memoryShopifyTokens();

    await store.put(TENANT, SHOP, 'token-1');
    expect(store.read(TENANT, SHOP)).toBe('token-1');
    expect(store.read(TENANT, 'altra.myshopify.com')).toBeUndefined();

    await store.remove(TENANT, SHOP);
    expect(store.read(TENANT, SHOP)).toBeUndefined();
  });
});
