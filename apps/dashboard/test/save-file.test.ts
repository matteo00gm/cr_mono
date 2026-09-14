import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveTextFile } from '../src/features/catalog/save-file.js';

/**
 * The console's one download path (P1-23, P1-30).
 *
 * Every component that writes a file takes this as a prop so its own test can
 * read a string, which left this function the one thing nothing ran. What it
 * promises is small and silent when broken: the file carries the name and the
 * encoding it was given, and the object URL is released — a URL left behind
 * keeps a megabyte-scale catalogue export in memory for as long as the tab is
 * open.
 */

/*
 * jsdom implements neither static, so they are defined for the test and
 * removed after it rather than left behind for the next file in the worker.
 */
const defineStatic = (name: 'createObjectURL' | 'revokeObjectURL', value: unknown) => {
  Object.defineProperty(URL, name, { value, configurable: true, writable: true });
};

afterEach(() => {
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  vi.restoreAllMocks();
});

describe('saveTextFile', () => {
  it('downloads the text under its name, then releases the object URL', () => {
    const events: string[] = [];
    const blobs: Blob[] = [];
    const links: { href: string; download: string }[] = [];

    defineStatic('createObjectURL', (blob: Blob) => {
      blobs.push(blob);
      events.push('create');
      return 'blob:catalogo-1';
    });
    defineStatic('revokeObjectURL', (url: string) => {
      events.push(`revoke ${url}`);
    });

    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      links.push({ href: this.href, download: this.download });
      events.push('click');
    });

    const csv = 'nome;note\nBarolo;caffè e tabacco\n';

    saveTextFile(csv, 'catalogo.csv');

    expect(links).toEqual([{ href: 'blob:catalogo-1', download: 'catalogo.csv' }]);

    // Released, and released after the click rather than before it — revoking
    // first would hand the browser a URL that no longer resolves.
    expect(events).toEqual(['create', 'click', 'revoke blob:catalogo-1']);

    // UTF-8, declared: a spreadsheet that guesses the encoding turns `è` into
    // two characters, which is P1-17's whole subject.
    expect(blobs[0]?.type).toBe('text/csv;charset=utf-8');
    expect(blobs[0]?.size).toBe(new TextEncoder().encode(csv).length);
  });
});
