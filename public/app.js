/* global CheckoutWebComponents */
// Panier Box - Checkout.com Flow demo (browser)
// Based on Checkout.com's Flow project template.

const $ = (id) => document.getElementById(id);
const euros = (cents) => "€" + (cents / 100).toFixed(2);
let catalogue = null;
let currentPaymentId = null;
let currentOrder = null;

// ---------------------------------------------------------------------------
// 1. BASKET: show the boxes and add-ons from the server's catalogue
// ---------------------------------------------------------------------------
async function loadShop() {
  catalogue = await (await fetch("/catalogue")).json();

  $("boxes").innerHTML = Object.entries(catalogue.boxes)
    .map(([id, b], i) => `
      <label class="option">
        <input type="radio" name="box" value="${id}" ${i === 0 ? "checked" : ""} />
        ${b.name} <span>${euros(b.price)}</span>
        <small>${b.type}${b.dispatchInDays ? ` · ships in ${b.dispatchInDays} days` : ""}</small>
      </label>`)
    .join("");

  $("addons").innerHTML = Object.entries(catalogue.addons)
    .map(([id, a]) => `
      <label class="option">
        <input type="checkbox" name="addon" value="${id}" /> ${a.name} <span>${euros(a.price)}</span>
      </label>`)
    .join("");

  // Delivery countries (France first, selected by default)
  const methodNames = { card: "Cards", googlepay: "Google Pay", mbway: "MB WAY" };
  $("countries").innerHTML = Object.entries(catalogue.countries)
    .map(([code, c], i) => `
      <label class="option">
        <input type="radio" name="country" value="${code}" ${i === 0 ? "checked" : ""} />
        ${c.name}
        <small>${c.methods.map((m) => methodNames[m] || m).join(" · ")}${code === "FR" ? " (incl. Cartes Bancaires)" : ""}</small>
      </label>`)
    .join("");

  // Scheduled box: delivery date between tomorrow and 14 days from today
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  $("delivery-date").min = day(1);
  $("delivery-date").max = day(14);
  $("delivery-date").value = day(9);

  $("shop").addEventListener("change", updateBasket);
  updateBasket();
}

function getBasket() {
  return {
    box: document.querySelector("input[name=box]:checked").value,
    deliveryDate: $("delivery-date").value,
    addons: [...document.querySelectorAll("input[name=addon]:checked")].map((el) => el.value),
    country: document.querySelector("input[name=country]:checked").value,
  };
}

// Total shown to the customer (display only: the server recalculates it)
function updateBasket() {
  const basket = getBasket();
  $("date-row").hidden = basket.box !== "scheduled";
  $("sub-note").hidden = !catalogue.boxes[basket.box].subscription;
  const total =
    catalogue.boxes[basket.box].price +
    basket.addons.reduce((sum, id) => sum + catalogue.addons[id].price, 0);
  $("total").textContent = euros(total);
}

// ---------------------------------------------------------------------------
// 2. CHECKOUT: create the payment session for this basket and mount Flow
// ---------------------------------------------------------------------------
$("btn-continue").onclick = async () => {
  $("shop-error").textContent = "";
  const { publicKey } = await (await fetch("/config")).json();

  const response = await fetch("/create-payment-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(getBasket()),
  });
  const paymentSession = await response.json();
  if (!response.ok) {
    $("shop-error").textContent = paymentSession.error || "Could not start the payment.";
    console.error("Error creating payment session", paymentSession);
    return;
  }

  // Lock basket and country: the session is for this exact amount and address
  document
    .querySelectorAll("#shop input, #delivery input, #delivery button")
    .forEach((el) => (el.disabled = true));
  $("checkout").hidden = false;

  const checkout = await CheckoutWebComponents({
    publicKey,
    environment: "sandbox",
    locale: catalogue.countries[getBasket().country].locale, // "fr" or "pt"
    paymentSession,
    onPaymentCompleted: (_component, paymentResponse) => {
      triggerToast("successToast");
      showOrder(paymentResponse.id);
    },
    onError: (component, error) => {
      console.log("onError", error, "Component", component.type);
      triggerToast("failedToast");
    },
  });

  checkout.create("flow").mount("#flow-container");
};

function triggerToast(id) {
  $(id).classList.add("show");
  setTimeout(() => $(id).classList.remove("show"), 5000);
}

// Coming back from a redirect (e.g. 3DS): ?status=...&cko-payment-id=...
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("status") === "succeeded") triggerToast("successToast");
if (urlParams.get("status") === "failed") triggerToast("failedToast");

// ---------------------------------------------------------------------------
// 3. OPS VIEW: payment status + capture / void / refund / renewal buttons
// ---------------------------------------------------------------------------
function showOrder(id) {
  currentPaymentId = id;
  $("ops").hidden = false;
  refreshStatus();
}

async function refreshStatus() {
  const p = await (await fetch(`/payments/${currentPaymentId}`)).json();
  $("payment-status").textContent = `${p.status} · ${euros(p.amount || 0)}`;
  // Subscription: once the card is stored, weekly renewals can be charged
  currentOrder = p.order;
  $("btn-renew").hidden = !(p.order && p.order.subscription && p.order.instrumentId);
}

async function action(name) {
  $("ops-message").textContent = "";
  const res = await fetch(`/payments/${currentPaymentId}/${name}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $("ops-message").textContent =
      `${name} refused: ${(body.error_codes || [body.error || res.status]).join(", ")}`;
  }
  // Capture / void / refund are processed asynchronously: re-check shortly after
  setTimeout(refreshStatus, 1500);
}

$("btn-capture").onclick = () => action("capture");
$("btn-void").onclick = () => action("void");
$("btn-refund").onclick = () => action("refund");

// Weekly renewal: the server charges the stored card (merchant-initiated, no customer, no 3DS)
$("btn-renew").onclick = async () => {
  $("ops-message").textContent = "";
  const res = await fetch(`/subscriptions/${currentOrder.reference}/renew`, { method: "POST" });
  const r = await res.json();
  if (!res.ok || !r.id) {
    $("ops-message").textContent =
      `Renewal refused: ${(r.error_codes || [r.error || res.status]).join(", ")}`;
    return;
  }
  // Show the renewal payment in the ops panel (it can then be captured at dispatch)
  showOrder(r.id);
  $("ops-message").textContent =
    `Renewal ${r.status}${r.response_summary ? ` (${r.response_code} ${r.response_summary})` : ""}`;
};

// ---------------------------------------------------------------------------
// 4. WEBHOOKS received by the server
// ---------------------------------------------------------------------------
// Readable title and colour for each Checkout.com event
const EVENT_INFO = {
  payment_approved: ["Payment authorised", "ok"],
  payment_declined: ["Payment declined", "bad"],
  payment_pending: ["Payment pending", "wait"],
  payment_captured: ["Payment captured", "ok"],
  payment_capture_declined: ["Capture declined", "bad"],
  payment_voided: ["Authorisation voided", "info"],
  payment_void_declined: ["Void declined", "bad"],
  payment_refunded: ["Payment refunded", "info"],
  payment_refund_declined: ["Refund declined", "bad"],
  payment_expired: ["Payment expired", "bad"],
};

let latestEventId = null;

async function refreshEvents() {
  const events = await (await fetch("/events")).json();
  if (!events.length) return;

  $("events").innerHTML = events
    .map((e) => {
      const [title, tone] = EVENT_INFO[e.type] || [e.type, "info"];
      const time = new Date(e.receivedAt).toLocaleTimeString();
      const amount = e.amount != null ? euros(e.amount) : "";
      const current = e.paymentId === currentPaymentId ? " current" : "";
      return `
        <div class="event ${tone}${current}">
          <div class="event-head">
            <strong>${title}</strong>
            <span>${amount}</span>
          </div>
          <small>${time} · Order ${e.reference || "-"}${e.orderType ? ` · ${e.orderType}` : ""}</small>
          <small class="mono">${e.paymentId || ""} · ${e.type}</small>
        </div>`;
    })
    .join("");

  // A new event for the payment on screen: refresh its status straight away
  // (the webhook, not a timer, tells us the status changed)
  if (events[0].id !== latestEventId) {
    latestEventId = events[0].id;
    if (currentPaymentId && events[0].paymentId === currentPaymentId) refreshStatus();
  }
}
setInterval(refreshEvents, 3000);

loadShop().then(() => {
  const paymentId = urlParams.get("cko-payment-id");
  if (paymentId) showOrder(paymentId);
});
