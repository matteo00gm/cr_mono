import { describe, expect, it } from 'vitest';

describe('dashboard test wiring', () => {
  it('runs in the jsdom environment', () => {
    const el = document.createElement('div');
    el.textContent = 'dashboard';
    document.body.appendChild(el);

    expect(document.body.querySelector('div')?.textContent).toBe('dashboard');
  });
});
