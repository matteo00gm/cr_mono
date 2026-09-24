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
  /** Absent when the storefront has no cart we can reach: the card degrades to a link (§1.6). */
  readonly onAdd?:
    ((item: { productId: string; variantId: string | null }) => Promise<void>) | undefined;
  /** Shopify needs one; every other adapter takes the product id (P3-11). */
  readonly variantId?: string | null | undefined;
  /** True when this adapter cannot add a wine that has no variant id. */
  readonly needsVariantId?: boolean | undefined;
  /** Called when a shopper follows the link to the wine (P3-20). */
  readonly onDetail?: ((productId: string) => void) | undefined;
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

/** What the add button is doing, which is three things and not a boolean. */
type Adding = 'idle' | 'busy' | 'done' | 'failed';

export const ProductCard = ({
  productId,
  reason,
  product,
  onAdd,
  variantId = null,
  needsVariantId = false,
  onDetail,
}: ProductCardProps) => {
  const t = useT();
  const locale = useLocale();
  const [imageFailed, setImageFailed] = useState(false);
  const [adding, setAdding] = useState<Adding>('idle');

  const image = imageFailed ? undefined : asHttpUrl(product.imageUrl);
  const link = asHttpUrl(product.productUrl);
  const badge = badgeKeyOf(product.stockStatus);

  /*
   * **Out of stock means no add-to-cart** (§1.5), and a missing variant id
   * means the same thing on Shopify: a seller left a column blank, and a button
   * that failed on click would look like our bug rather than their setup.
   */
  const sellable =
    onAdd !== undefined &&
    product.stockStatus !== 'OUT_OF_STOCK' &&
    !(needsVariantId && (variantId === null || variantId === ''));

  const add = (): void => {
    if (onAdd === undefined) return;

    setAdding('busy');
    void onAdd({ productId, variantId }).then(
      () => {
        setAdding('done');
      },
      () => {
        setAdding('failed');
      },
    );
  };

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

        <p class="card-actions">
          {sellable && (
            <button
              type="button"
              class="card-add"
              onClick={add}
              disabled={adding === 'busy'}
              data-state={adding}
            >
              {adding === 'busy' && t('adding')}
              {adding === 'done' && t('added')}
              {adding === 'failed' && t('addFailed')}
              {adding === 'idle' && t('addToCart')}
            </button>
          )}

          {link !== undefined && (
            <a
              class="card-link"
              href={link}
              onClick={() => {
                onDetail?.(productId);
              }}
              target="_blank"
              /*
               * `noopener` is the security half: without it the opened page gets a
               * handle on `window.opener` and can navigate the seller's own tab
               * somewhere else. `noreferrer` keeps the shopper's page out of a
               * third party's logs.
               */
              rel="noopener noreferrer"
            >
              {sellable ? t('details') : t('viewProduct')}
            </a>
          )}
        </p>
      </div>
    </li>
  );
};
