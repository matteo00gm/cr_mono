# Collegare il carrello del tuo sito

> P3-12 · §1.6 — la guida che un negozio non-Shopify segue per far funzionare
> **Aggiungi al carrello** dentro il sommelier.

Il widget riconosce da solo due tipi di negozio:

- **Shopify**, usando `/cart/add.js` del tuo tema. Non devi fare nulla.
- **Un carrello tuo**, se lo dichiari in uno dei due modi qui sotto.

Se non trova né l'uno né l'altro, le schede dei vini mostrano **Vedi prodotto**
con un link alla pagina del vino, invece di un pulsante che non funziona.

---

## Modo 1 — un oggetto su `window`

Il più semplice, e l'unico che può mostrare il numero di articoli nel carrello.

```js
window.__sommelierCart = {
  // Riceve l'id del prodotto nel catalogo che hai caricato da noi.
  async addToCart({ productId, quantity }) {
    await fetch('/api/carrello', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: productId, quantity }),
    });
  },

  // Sincrono o asincrono, come preferisci.
  getCount() {
    return document.querySelectorAll('.carrello-riga').length;
  },
};
```

**Va definito prima che il visitatore apra il widget.** Il widget lo cerca
quando apre il pannello, non quando la pagina si carica, quindi basta che
esista entro quel momento.

**Entrambi i metodi devono esserci.** Se ne manca uno, o non è una funzione, il
widget non usa il tuo carrello: preferiamo una scheda con _Vedi prodotto_ a una
chiamata dentro il tuo codice che non sappiamo se funziona.

**Se `addToCart` lancia un errore o non risponde entro 5 secondi**, il visitatore
legge _Non sono riuscito ad aggiungerlo_. Non propaghiamo mai l'errore nella tua
pagina.

---

## Modo 2 — un evento

Utile se il carrello vive dentro un framework che preferisci non esporre su
`window`.

Aggiungi `data-cart="event"` allo script che hai incollato:

```html
<script
  type="module"
  src="https://cdn.catalogorosso.com/loader.js"
  data-key="pk_live_..."
  data-cart="event"
  async
></script>
```

> `type="module"` serve sempre, non solo per questo modo.

Poi ascolta l'evento e **rispondi**:

```js
document.addEventListener('sommelier:add-to-cart', async (event) => {
  const { productId, quantity } = event.detail;

  try {
    await ilMioCarrello.aggiungi(productId, quantity);
    document.dispatchEvent(
      new CustomEvent('sommelier:cart-updated', { detail: { productId, ok: true } }),
    );
  } catch {
    document.dispatchEvent(
      new CustomEvent('sommelier:cart-updated', { detail: { productId, ok: false } }),
    );
  }
});
```

**La risposta è obbligatoria.** Senza, ogni aggiunta sembrerebbe riuscita e il
visitatore si troverebbe un carrello vuoto alla cassa. Se non rispondi entro
5 secondi il widget lo tratta come un errore, che è esattamente ciò che è.

`ok: false` è un rifiuto tuo — vino esaurito, quantità non disponibile — ed è
distinto dal silenzio: uno è il tuo carrello che dice di no, l'altro è la tua
pagina che non dice niente.

Il `productId` nella risposta è facoltativo, ma se lo includi deve essere quello
che ti abbiamo passato: così due aggiunte ravvicinate non si confondono.

**Questo modo non può mostrare il numero di articoli.** Servirebbe un secondo
giro di eventi e un secondo timeout; se il contatore ti interessa, usa il Modo 1.

---

## Dichiarare esplicitamente

`data-cart` accetta quattro valori, e vince sempre su ciò che rileviamo da soli:

| Valore    | Quando serve                                                            |
| --------- | ----------------------------------------------------------------------- |
| `shopify` | Shopify headless, dove `window.Shopify` non esiste ma `/cart/add.js` sì |
| `generic` | Ridondante: se l'oggetto c'è lo troviamo comunque                       |
| `event`   | **Obbligatorio** per il Modo 2 — un listener non è rilevabile           |
| `none`    | Vuoi solo i consigli, senza pulsante di acquisto                        |

---

## Dove va il pulsante del carrello

L'icona nell'intestazione del pannello porta il visitatore alla **tua** pagina
carrello, non a una nostra: la configuri dalla console (`cartUrl`, di default
`/cart`). Accettiamo solo un percorso relativo o un URL sullo stesso dominio del
negozio — un indirizzo esterno viene ignorato e si torna a `/cart`.
