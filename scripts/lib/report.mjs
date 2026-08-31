/**
 * Shared output helpers for the CI gate scripts.
 *
 * Extracted because both gates render the same shape of evidence, and a gate
 * whose output is hard to read gets skimmed — which is how a FAIL row ends up
 * being scrolled past.
 */

/** Fixed-width table. Column widths come from the widest cell, header included. */
export const table = (headers, rows) => {
  const all = [headers, ...rows];
  const width = headers.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(width[i])).join('  ');
  return [line(headers), '  ' + width.map((n) => '-'.repeat(n)).join('  '), ...rows.map(line)].join(
    '\n',
  );
};

/** Abort with a message the reader can act on, not just a stack trace. */
export const die = (label, detail) => {
  console.error('\n  ' + label + '\n');
  if (detail) console.error('  ' + String(detail).split('\n').join('\n  ') + '\n');
  process.exit(1);
};
