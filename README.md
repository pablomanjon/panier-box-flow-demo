# Panier Box – Checkout.com Flow demo

A simple web checkout showing how Panier Box would take payments with Checkout.com Flow.
Built on Checkout.com's official Flow project template (Node + plain JavaScript).

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

### Webhooks
Expose your machine (e.g. `ngrok http 3000`), add a webhook to `https://<url>/webhooks` in the Dashboard, and put its key in `CKO_WEBHOOK_SECRET`.
