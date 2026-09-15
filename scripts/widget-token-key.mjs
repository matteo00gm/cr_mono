#!/usr/bin/env node
/**
 * Generates the widget token keyset, or rotates one (P2-11).
 *
 * Keys are generated out of band, as §5.7 and P2-11 ask, and **written to
 * stdout only** — never to a file, never to an argument — so the private key
 * goes straight into the secret without touching a disk or a shell history:
 *
 *   node scripts/widget-token-key.mjs | sst secret set WidgetTokenKeys --stage <stage>
 *
 * Rotation reads the current keyset on stdin and writes a new one: a fresh key
 * first, which signs from the next deploy, and the previous signing key second,
 * which keeps verifying the tokens it signed until they expire. Anything older is
 * dropped, because at most two keys are ever active:
 *
 *   <current keyset> | node scripts/widget-token-key.mjs --rotate | sst secret set WidgetTokenKeys --stage <stage>
 *
 * Needs `pnpm build` first: the key code is imported from `packages/security/dist`,
 * the same module the API loads, so what this writes is what the API reads.
 */
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { die } from './lib/report.mjs';

const { generateWidgetTokenKey, loadWidgetTokenKeys } =
  await import('../packages/security/dist/tokens/keys.js');

const readStdin = async () => {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

/** Dated, so the header of a token says roughly when its key was made; random, so two runs a day differ. */
const kid = `wtk-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const fresh = await generateWidgetTokenKey(kid);

let keys = [fresh];

if (process.argv.includes('--rotate')) {
  const current = await readStdin();

  // Refuse to rotate from a keyset the API itself would refuse, rather than carry a broken key forward.
  try {
    await loadWidgetTokenKeys(current);
  } catch (error) {
    die(`the keyset on stdin is unusable, so there is nothing to rotate from: ${error.message}`);
  }

  const [previous] = JSON.parse(current).keys;
  keys = [fresh, previous];
}

process.stdout.write(`${JSON.stringify({ keys })}\n`);
