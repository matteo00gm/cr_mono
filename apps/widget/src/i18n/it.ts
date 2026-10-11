/**
 * Italian, the source language (P3-14).
 *
 * **Copy is authored and reviewed here**, and every other catalogue is a
 * translation of this one. That is why `Messages` is derived from this file
 * rather than declared separately: a key added here and forgotten in `en.ts` is
 * a typecheck failure, and a key declared in the abstract that nobody wrote
 * Italian for is not possible at all.
 *
 * **Nothing here names a plan, a price or a count** (§1.3). A shopper on a
 * winery's storefront is not our customer and their limits are not that
 * shopper's business — the one number in this file is a countdown in seconds,
 * which §1.3 asks for by name.
 */
export const it = {
  /* The chat itself. */
  composerLabel: 'Scrivi al sommelier',
  composerPlaceholder: 'Che vino mi consigli?',
  send: 'Invia',
  retry: 'Riprova',
  /*
   * Under the composer until the first question (P3-23, Open Decision 7). The
   * winery's staff can read what a shopper asks, and a shopper should know
   * that before typing — and what not to type. It informs; it asks nothing.
   */
  privacyNotice:
    'La cantina legge le domande per migliorare il catalogo. Non scrivere dati personali.',

  /* The five states of §1.3. `active` has no notice: the chat is the notice. */
  disabled: 'Il sommelier AI non è attivo al momento.',
  quota: 'Il sommelier si riposa. Torna presto!',
  rateLimited: 'Un attimo di pazienza. Riprova tra {seconds} s.',
  rateLimitedReady: 'Ci siamo. Puoi riprovare.',
  errorProvider: 'Non riesco a rispondere in questo momento.',
  errorNetwork: 'Connessione interrotta.',

  /* The card (P3-08, §1.5). */
  details: 'Dettagli',
  outOfStock: 'Non disponibile',
  preorder: 'Su ordinazione',

  /* The cart (P3-11 → P3-13, §1.6). */
  addToCart: 'Aggiungi al carrello',
  added: 'Aggiunto',
  adding: 'Aggiungo…',
  addFailed: 'Non sono riuscito ad aggiungerlo.',
  openCart: 'Apri il carrello',
  viewProduct: 'Vedi prodotto',
} as const;

/**
 * The shape every catalogue has to fill.
 *
 * Derived, not declared — see above. `string` rather than the literal types, so
 * a translation is a different string rather than a type error.
 */
export type Messages = { readonly [K in keyof typeof it]: string };
