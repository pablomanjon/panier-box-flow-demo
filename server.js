// Panier Box - Checkout.com Flow demo (server)
// Built on Checkout.com's Flow project template. Changes are marked "PANIER BOX:".
// The secret key stays here. The browser never sees it, and never sees card numbers.

require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const app = express();

const SECRET_KEY = process.env.CKO_SECRET_KEY;
const API = process.env.CKO_API_URL || "https://api.sandbox.checkout.com";

// Helper: call Checkout.com with the secret key, log one line, never crash.
async function cko(method, path, body) {
  try {
    const request = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await request.text();
    console.log(`${method} ${path} -> ${request.status}`);
    return { status: request.status, data: text ? JSON.parse(text) : {} };
  } catch (err) {
    console.error("Checkout.com call failed:", err.message);
    return { status: 502, data: { error: err.message } };
  }
}

// ---------------------------------------------------------------------------
// PANIER BOX: CATALOGUE (prices live on the server, never trusted from the browser)
// Amounts are in minor units: 6800 = EUR 68.00
// ---------------------------------------------------------------------------
const BOXES = {
  weekly: { name: "Weekly meal box subscription (4 people)", price: 6800, type: "Subscription", dispatchInDays: 2, subscription: true },
  scheduled: { name: "Scheduled box (you choose the delivery date)", price: 6800, type: "Scheduled" },
  preorder: { name: "Black Friday pre-order box", price: 7900, type: "Pre-order", dispatchInDays: 10 },
};
const ADDONS = {
  oil: { name: "Olive oil 50cl", price: 950 },
  bread: { name: "Sourdough loaf", price: 450 },
  wine: { name: "Bottle of Bordeaux", price: 1200 },
};

// PANIER BOX: delivery countries. The country decides the address and the payment methods.
// Cartes Bancaires is not a separate method in Flow: it lives inside "card" and is
// offered for French co-badged cards. MB WAY: Portugal only, needs billing country PT + EUR.
const COUNTRIES = {
  FR: {
    name: "France",
    locale: "fr",
    methods: ["card", "googlepay"],
    address: { address_line1: "12 Rue de Rivoli", city: "Paris", zip: "75001", country: "FR" },
  },
  PT: {
    name: "Portugal",
    locale: "pt",
    methods: ["card", "googlepay", "mbway"],
    address: { address_line1: "Rua Augusta 100", city: "Lisboa", zip: "1100-053", country: "PT" },
  },
};

// Checkout.com voids an authorisation that isn't captured within 7 days
// (docs: "Capture a payment"). Sarah dispatches up to 10 days after the order.
const AUTH_VALID_DAYS = 7;

const orders = {}; // reference -> order details (in production: Panier Box's database)

const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
const day = (date) => date.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// WEBHOOKS (bonus)
// Julien's order service takes up to 30 s per notification. Checkout.com must
// not wait that long, or deliveries fail and are retried. So:
// verify signature -> answer 200 at once -> process afterwards, ignore duplicates
// (webhooks are sent "at least once" and can arrive out of order).
// Must come before express.json(): the signature is computed on the raw body.
// ---------------------------------------------------------------------------
const seenEventIds = new Set();
const eventLog = [];

app.post("/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  const expected = crypto
    .createHmac("sha256", process.env.CKO_WEBHOOK_SECRET || "")
    .update(req.body)
    .digest("hex");
  const received = req.headers["cko-signature"] || "";
  const valid =
    received.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!valid) return res.status(401).send("Invalid signature");

  const event = JSON.parse(req.body.toString());
  res.sendStatus(200); // acknowledge immediately

  if (seenEventIds.has(event.id)) return; // duplicate, already handled
  seenEventIds.add(event.id);

  // In production: put the event on a queue for the (slow) order service.
  setImmediate(() => {
    const d = event.data || {};
    const order = orders[d.reference];
    eventLog.unshift({
      id: event.id,
      type: event.type, // e.g. payment_captured
      receivedAt: new Date().toISOString(),
      paymentId: d.id,
      amount: d.amount,
      currency: d.currency,
      reference: d.reference,
      orderType: order ? order.type : null,
      responseSummary: d.response_summary, // e.g. "Approved" / decline reason
    });
    console.log("Webhook processed:", event.type, d.id);
  });
});

app.use(express.static("public"));
app.use(express.json());

// Public key and catalogue for the page (both safe to expose)
app.get("/config", (_req, res) => res.json({ publicKey: process.env.CKO_PUBLIC_KEY }));
app.get("/catalogue", (_req, res) => res.json({ boxes: BOXES, addons: ADDONS, countries: COUNTRIES }));

// ---------------------------------------------------------------------------
// CREATE A PAYMENT SESSION for the customer's basket
// ---------------------------------------------------------------------------
app.post("/create-payment-sessions", async (req, res) => {
  const { box: boxId, deliveryDate, addons = [], country: countryCode } = req.body;
  const country = COUNTRIES[countryCode];
  if (!country) return res.status(400).json({ error: "Choose France or Portugal" });
  const box = BOXES[boxId];
  if (!box) return res.status(400).json({ error: "Choose a box" });

  // Dispatch date: fixed for weekly / pre-order, chosen by the customer for scheduled
  const now = new Date();
  let dispatch;
  if (boxId === "scheduled") {
    dispatch = new Date(deliveryDate);
    // compare calendar days (YYYY-MM-DD) to avoid time-zone surprises
    if (isNaN(dispatch) || deliveryDate < day(addDays(now, 1)) || deliveryDate > day(addDays(now, 14))) {
      return res.status(400).json({ error: "Pick a delivery date 1 to 14 days from today" });
    }
  } else {
    dispatch = addDays(now, box.dispatchInDays);
  }

  // Basket and total, priced on the server
  const items = [{ name: box.name, quantity: 1, unit_price: box.price }];
  for (const id of addons) {
    if (ADDONS[id]) items.push({ name: ADDONS[id].name, quantity: 1, unit_price: ADDONS[id].price });
  }
  const amount = items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);

  const reference = "PB-" + Date.now();
  const authExpires = addDays(now, AUTH_VALID_DAYS);
  orders[reference] = {
    reference,
    type: box.type,
    country: country.name,
    items: items.map((i) => i.name),
    dispatchDate: day(dispatch),
    authExpires: day(authExpires),
    // true when the box ships after the authorisation would have expired
    dispatchAfterExpiry: day(dispatch) > day(authExpires),
    subscription: !!box.subscription,
  };

  // PANIER BOX: subscription vs one-off order.
  // Subscription: the first payment is a customer-initiated "Recurring" payment,
  // with 3DS and the mandate indicator. Checkout.com stores the card (src_...) so
  // the weekly renewals can be charged without the customer (see /renew below).
  // Cards only: MB WAY and Google Pay renewals are out of scope for this demo.
  const paymentSetup = box.subscription
    ? {
        payment_type: "Recurring",
        "3ds": { enabled: true, challenge_indicator: "challenge_requested_mandate" },
        payment_method_configuration: { card: { store_payment_details: "enabled" } },
        enabled_payment_methods: ["card"],
      }
    : {
        payment_type: "Regular",
        "3ds": { enabled: true }, // stays on: PSD2 strong customer authentication (FR and PT)
        // FR: cards incl. CB + Google Pay, PT: cards + Google Pay + MB WAY
        enabled_payment_methods: country.methods,
      };

  const { status, data } = await cko("POST", "/payment-sessions", {
    amount,
    currency: "EUR",
    reference,
    description: `Panier Box - ${box.type} order`,
    processing_channel_id: process.env.CKO_PROCESSING_CHANNEL_ID,

    capture: false, // authorise now, capture when the box is dispatched
    ...paymentSetup, // payment type, 3DS and payment methods (see above)

    customer: { email: "camille.martin@example.com", name: "Camille Martin" },
    billing: { address: country.address },
    shipping: { address: country.address },
    risk: { enabled: true },
    success_url: "http://localhost:3000/?status=succeeded",
    failure_url: "http://localhost:3000/?status=failed",
    metadata: { order_type: box.type, dispatch_date: day(dispatch), country: countryCode },
    items,
  });

  res.status(status).send(data);
});

// ---------------------------------------------------------------------------
// ORDER LIFECYCLE (what Sarah's ops team does after the order)
// ---------------------------------------------------------------------------

// Payment status + the Panier Box order it belongs to
app.get("/payments/:id", async (req, res) => {
  const { status, data } = await cko("GET", `/payments/${req.params.id}`);
  const order = orders[data.reference];

  // PANIER BOX: first subscription payment -> keep the stored card and the payment ID.
  // In production, save these against the customer in Panier Box's database.
  if (order && order.subscription && !order.instrumentId && data.source && data.source.id) {
    order.instrumentId = data.source.id; // src_... (stored card)
    order.firstPaymentId = data.id; // initial customer-initiated payment
  }

  res.status(status).json({
    id: data.id,
    status: data.status, // Authorized, Captured, Voided, Refunded...
    amount: data.amount,
    scheme: data.source && data.source.scheme,
    order: order || null,
  });
});

// ---------------------------------------------------------------------------
// PANIER BOX: WEEKLY RENEWAL = merchant-initiated payment (MIT)
// Panier Box charges the stored card without the customer present.
// MITs are out of SCA scope, so no 3DS. previous_payment_id links the renewal
// to the first payment, as the card schemes require.
// (Failed renewals: retry based on the decline code, not every day for 14 days.)
// ---------------------------------------------------------------------------
app.post("/subscriptions/:reference/renew", async (req, res) => {
  const sub = orders[req.params.reference];
  if (!sub || !sub.instrumentId) {
    return res.status(400).json({ error: "No stored card for this subscription yet" });
  }

  sub.renewals = (sub.renewals || 0) + 1;
  const reference = `${sub.reference}-R${sub.renewals}`;
  const now = new Date();
  orders[reference] = {
    reference,
    type: `Subscription renewal #${sub.renewals} (MIT)`,
    country: sub.country,
    items: [BOXES.weekly.name],
    dispatchDate: day(addDays(now, BOXES.weekly.dispatchInDays)),
    authExpires: day(addDays(now, AUTH_VALID_DAYS)),
    dispatchAfterExpiry: false,
    subscription: false,
  };

  const { status, data } = await cko("POST", "/payments", {
    source: { type: "id", id: sub.instrumentId },
    amount: BOXES.weekly.price, // the box only: add-ons were one-off
    currency: "EUR",
    reference,
    processing_channel_id: process.env.CKO_PROCESSING_CHANNEL_ID,
    payment_type: "Recurring",
    merchant_initiated: true,
    previous_payment_id: sub.firstPaymentId,
    capture: false, // same model: authorise now, capture at dispatch
  });

  res.status(status).json({
    id: data.id,
    status: data.status,
    response_code: data.response_code,
    response_summary: data.response_summary,
    error_codes: data.error_codes,
  });
});

// Box dispatched -> CAPTURE (take the money)
app.post("/payments/:id/capture", async (req, res) => {
  const { status, data } = await cko("POST", `/payments/${req.params.id}/captures`, {});
  res.status(status).json(data);
});

// Cancelled BEFORE dispatch -> VOID (release the hold: nothing was charged, so no refund)
app.post("/payments/:id/void", async (req, res) => {
  const { status, data } = await cko("POST", `/payments/${req.params.id}/voids`, {});
  res.status(status).json(data);
});

// Problem AFTER dispatch -> REFUND (only possible once captured)
app.post("/payments/:id/refund", async (req, res) => {
  const { status, data } = await cko("POST", `/payments/${req.params.id}/refunds`, {});
  res.status(status).json(data);
});

// Webhooks received, shown on the page
app.get("/events", (_req, res) => res.json(eventLog));

app.listen(3000, () =>
  console.log("Node server listening on port 3000: http://localhost:3000/")
);
