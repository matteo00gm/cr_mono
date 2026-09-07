import { render } from 'preact';

import { App } from './app.js';
import './tokens.css';

/**
 * The mount point (P0-57).
 *
 * Kept to this — one render call — so that everything above it is a component a
 * test can mount directly. A shell whose interesting logic lives in the entry
 * module is a shell that can only be tested through a full page load.
 */
const root = document.querySelector('#root');

if (!root) {
  // index.html ships the element, so an absent one means the HTML and this
  // bundle have drifted. Throwing beats rendering nothing, which looks like a
  // blank page and gets reported as "the dashboard is down".
  throw new Error('#root is missing from index.html');
}

render(<App />, root);
