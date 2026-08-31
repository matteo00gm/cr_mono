import { describe, expect, it } from 'vitest';

describe('widget test wiring', () => {
  it('runs in the jsdom environment', () => {
    const el = document.createElement('div');
    el.textContent = 'widget';
    document.body.appendChild(el);

    expect(document.body.querySelector('div')?.textContent).toBe('widget');
  });
});
