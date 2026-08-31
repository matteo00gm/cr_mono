import { describe, expect, it } from 'vitest';

describe('core test wiring', () => {
  it('runs in the node environment, with no DOM in scope', () => {
    expect('document' in globalThis).toBe(false);
    expect('window' in globalThis).toBe(false);
  });
});
