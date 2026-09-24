import type { WidgetProduct } from '@catalogorosso/api-client';
import { useState } from 'preact/hooks';

import { useLocale, useT } from '../i18n/useT.js';
import { asHttpUrl, asLine, asPrice } from '../sanitise.js';

/**
 * One wine, as a shopper sees it (P3-08, §1.5).
 *
 * **Text nodes only.** No `innerHTML`, no `dangerouslySetInnerHTML` — Preact
 * escapes every interpolation, so the rule is simply that nobody reaches for
 * the escape hatch, and the P0-04 lint rule is what keeps it that way (§3.7).
 *
 * **Every field but `reason` comes from our own catalogue.** The model supplies
 * a `productId` and a sentence; the server replaces the rest from the row
 * before the event is sent (P2-25). A card built from model output is a card a
 * seeded tasting note can write, which is the whole of why §1.5 makes this a
 * security control rather than a style choice.
 *
 * **The rest of the card is still not trusted.** It is tenant-authored and
 * arrives through a spreadsheet import that anybody in a winery can edit — so
 * `sanitise.ts` caps it, strips what is not text, and refuses a URL that is not
 * `http` or `https`.
 */

export interface ProductCardProps {
  readonly productId: string;
  readonly reason: string;
  readonly product: WidgetProduct;
}

/** What a shopper is told about availability, when there is anything to say. */
const badgeKeyOf = (
  stockStatus: WidgetProduct['stockStatus'],
): 'outOfStock' | 'preorder' | undefined => {
  if (stockStatus === 'OUT_OF_STOCK') return 'outOfStock';
  if (stockStatus === 'PREORDER') return 'preorder';

  return undefined;
};

/** `Barolo Bussia — Rossi, 2016`, with whatever of that exists. */
const titleOf = (product: WidgetProduct): string =>
  [asLine(product.name, 80), [product.producer, product.vintage].filter(Boolean).join(', ')]
    .filter((part) => part !== '')
    .join(' — ');

export const ProductCard = ({ productId, reason, product }: ProductCardProps) => {
  const t = useT();
  const locale = useLocale();
  const [imageFailed, setImageFailed] = useState(false);

  const image = imageFailed ? undefined : asHttpUrl(product.imageUrl);
  const link = asHttpUrl(product.productUrl);
  const badge = badgeKeyOf(product.stockStatus);

  return (
    <li class="card" data-product-id={productId}>
      {image === undefined ? (
        /* A broken image on a wine card looks like a broken shop, so there is
         * always something in its place. */
        <span class="card-image card-image--missing" aria-hidden="true">
          {'\u{1F377}'}
        </span>
      ) : (
        <img
          class="card-image"
          src={image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => {
            setImageFailed(true);
          }}
        />
      )}

      <div class="card-body">
        <p class="card-title">{titleOf(product)}</p>
        <p class="card-reason">{asLine(reason)}</p>

        <p class="card-meta">
          <span class="card-price">{asPrice(product.priceCents, product.currency, locale)}</span>
          {badge !== undefined && <span class="card-badge">{t(badge)}</span>}
        </p>

        {link !== undefined && (
          <a
            class="card-link"
            href={link}
            target="_blank"
            /*
             * `noopener` is the security half: without it the opened page gets a
             * handle on `window.opener` and can navigate the seller's own tab
             * somewhere else. `noreferrer` keeps the shopper's page out of a
             * third party's logs.
             */
            rel="noopener noreferrer"
          >
            {t('details')}
          </a>
        )}
      </div>
    </li>
  );
};
