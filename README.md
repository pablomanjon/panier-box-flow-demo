# Panier Box – Checkout.com Flow demo

A simple web checkout showing how Panier Box would take payments with Checkout.com Flow.
Built on Checkout.com's official Flow project template (Node + plain JavaScript).

## What it shows

| Panier Box need | How the demo handles it |
|---|---|
| Weekly **subscription** | The first payment goes through Flow as a customer-initiated `Recurring` payment with 3DS (`challenge_requested_mandate`); Checkout.com stores the card (`src_...`). **Charge renewal** then charges it as a **merchant-initiated** payment (`merchant_initiated: true`, `previous_payment_id` = first payment): no customer, no 3DS (MITs are out of SCA scope). Cards only. |
| Weekly, **scheduled** and **pre-ordered** boxes, plus grocery add-ons | The customer picks a box (and a delivery date for scheduled boxes) and add-ons. The **server** prices the basket. Prices from the browser are never trusted. |
| Authorise at order, capture at dispatch | Payment session uses `capture: false`. The ops panel has **Capture** for when the box is dispatched. |
| Dispatch up to 10 days after the order | Uncaptured authorisations are voided after 7 days. The ops panel shows each order's **capture deadline** and flags boxes that ship after it. Recommended fix: save the card at checkout and authorise as a merchant-initiated payment just before dispatch. |
| Cancellation before dispatch | **Void**, not a refund: nothing was charged, so the hold is simply released. |
| Problem after dispatch | **Refund** (only once captured). |
| Delivery country decides the payment methods | **France:** cards (incl. Cartes Bancaires, offered inside the card form for French co-badged cards) and Google Pay. **Portugal:** cards, Google Pay and MB WAY (needs billing country PT and EUR; MB WAY must be enabled on the account). The country also sets the billing/shipping address and Flow's language. |
| 3DS | Kept **on** (PSD2 strong customer authentication in France). |
| PCI SAQ A | Card details are entered in Flow's secure fields. Our code never sees card numbers; the secret key stays on the server. |
| Webhooks (bonus) | `/webhooks` verifies the signature, replies `200` immediately, ignores duplicates and processes afterwards – instead of making Checkout.com wait up to 30 s. |

## Run it

Requires Node.js 18+.

```bash
npm install
cp .env.example .env    # fill in your sandbox keys
npm start
```

Open http://localhost:3000, build a basket, click **Continue to payment** and pay with test card `4242 4242 4242 4242` (any future expiry, CVV `100`).

### Keys (`.env`)
- `CKO_SECRET_KEY` – scopes: `payment-sessions` + payments (capture, void, refund, payment details)
- `CKO_PUBLIC_KEY` – scopes: `payment-sessions:pay`, `vault-tokenization`
- `CKO_PROCESSING_CHANNEL_ID` – `pc_...`
- `CKO_API_URL` – your account's sandbox URL, e.g. `https://{prefix}.api.sandbox.checkout.com`

### Webhooks (optional)
Expose your machine (e.g. `ngrok http 3000`), add a webhook to `https://<url>/webhooks` in the Dashboard, and put its key in `CKO_WEBHOOK_SECRET`.

## Files
| File | What it does |
|---|---|
| `server.js` | Catalogue and pricing, payment session, capture / void / refund, webhooks |
| `public/index.html` | The page: basket, payment, ops panel, webhooks |
| `public/app.js` | Basket, mounts Flow, ops buttons |

## Deliberately out of scope
- Scheduled renewals and smart retries of failed renewals (based on decline codes, instead of retrying daily for 14 days)
- Moving DimaPay's stored cards (credentials migration) so existing subscriptions keep renewing
- MB WAY (Portugal launch); Apple Pay and the mobile apps (Flow for iOS/Android)
- A real database and queue (orders and webhooks are kept in memory)
