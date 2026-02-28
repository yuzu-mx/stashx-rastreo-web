const lookupScreen = document.getElementById("lookupScreen");
const pendingScreen = document.getElementById("pendingScreen");
const localPreparingScreen = document.getElementById("localPreparingScreen");
const foraneoPreparingScreen = document.getElementById("foraneoPreparingScreen");
const localFulfilledScreen = document.getElementById("localFulfilledScreen");
const localFulfilledTrackingLabel = document.getElementById("localFulfilledTrackingLabel");
const localFulfilledTrackingNumber = document.getElementById("localFulfilledTrackingNumber");
const localFulfilledTrackingBtn = document.getElementById("localFulfilledTrackingBtn");
const trackingForm = document.getElementById("trackingForm");
const phoneInput = document.getElementById("phoneInput");
const orderInput = document.getElementById("orderInput");
const searchOrderBtn = document.getElementById("searchOrderBtn");
const toastRegion = document.getElementById("toastRegion");

const LOOKUP_ENDPOINT = "/.netlify/functions/order-lookup";
const ORDER_PREFIX = "ST-";
const ORDER_MIN_DIGITS = 3;
const ORDER_MAX_DIGITS = 9;

let phoneDigits = "";
let orderDigits = "";
let lastToast = { message: "", time: 0 };
let isSubmitting = false;

const statusScreens = [
  pendingScreen,
  localPreparingScreen,
  foraneoPreparingScreen,
  localFulfilledScreen,
].filter(Boolean);

function formatPhone(digits) {
  if (digits.length <= 2) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}`;
}

function isPhoneValid() {
  return phoneDigits.length === 10;
}

function isOrderValid() {
  return orderDigits.length >= ORDER_MIN_DIGITS;
}

function applyPhoneValue(rawValue) {
  const digits = String(rawValue || "").replace(/\D/g, "");
  phoneDigits = (digits.length > 10 ? digits.slice(-10) : digits).slice(0, 10);
  phoneInput.value = formatPhone(phoneDigits);
}

function applyOrderValue(rawValue) {
  orderDigits = String(rawValue || "")
    .replace(/\D/g, "")
    .slice(0, ORDER_MAX_DIGITS);
  orderInput.value = orderDigits.length > 0 ? `${ORDER_PREFIX}${orderDigits}` : "";
}

function placeCursorAtOrderEnd() {
  if (!orderInput || typeof orderInput.setSelectionRange !== "function") return;

  const position = orderInput.value.length;
  requestAnimationFrame(() => {
    try {
      orderInput.setSelectionRange(position, position);
    } catch {
      // Some mobile browsers can block range updates while keyboard is opening.
    }
  });
}

function prefillFromUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const phoneParam = params.get("phone");
  const orderParam =
    params.get("order_name") ||
    params.get("orderNumber") ||
    params.get("order_number");

  if (phoneParam) {
    applyPhoneValue(phoneParam);
  }

  if (orderParam) {
    applyOrderValue(orderParam);
  } else {
    applyOrderValue(orderInput.value);
  }
}

function updateButtonState() {
  searchOrderBtn.disabled = isSubmitting || !(isPhoneValid() && isOrderValid());
}

function setSubmittingState(value) {
  isSubmitting = value;
  phoneInput.disabled = value;
  orderInput.disabled = value;
  searchOrderBtn.textContent = value ? "BUSCANDO..." : "BUSCAR PEDIDO";
  updateButtonState();
}

function showToast(message) {
  const now = Date.now();
  if (lastToast.message === message && now - lastToast.time < 1200) {
    return;
  }

  lastToast = { message, time: now };

  const toast = document.createElement("p");
  toast.className = "toast";
  toast.textContent = message;
  toastRegion.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
  }, 2200);

  setTimeout(() => {
    toast.remove();
  }, 2500);
}

function validatePhoneWithToast() {
  if (!isPhoneValid()) {
    showToast("Ingresa un teléfono válido de 10 dígitos.");
    return false;
  }
  return true;
}

function validateOrderWithToast() {
  if (!isOrderValid()) {
    showToast("Ingresa al menos 3 números de pedido.");
    return false;
  }
  return true;
}

function showStatusScreen(screen) {
  if (!screen) return;

  lookupScreen.hidden = true;

  statusScreens.forEach((statusScreen) => {
    if (!statusScreen || statusScreen === screen) return;
    statusScreen.hidden = true;
    statusScreen.classList.remove("is-animating");
  });

  screen.hidden = false;
  screen.classList.remove("is-animating");
  void screen.offsetWidth;
  screen.classList.add("is-animating");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function showPendingScreen() {
  showStatusScreen(pendingScreen);
}

function showLocalPreparingScreen() {
  showStatusScreen(localPreparingScreen);
}

function showForaneoPreparingScreen() {
  showStatusScreen(foraneoPreparingScreen);
}

async function copyTextToClipboard(text) {
  const value = String(text || "").trim();
  if (!value) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Falls back to execCommand for older WebKit contexts.
    }
  }

  const helper = document.createElement("textarea");
  helper.value = value;
  helper.setAttribute("readonly", "");
  helper.style.position = "absolute";
  helper.style.left = "-9999px";
  document.body.appendChild(helper);
  helper.select();

  let didCopy = false;
  try {
    didCopy = document.execCommand("copy");
  } catch {
    didCopy = false;
  }

  document.body.removeChild(helper);
  return didCopy;
}

function normalizeTrackingUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const firstToken = raw.split(/[\s,]+/).find(Boolean);
  if (!firstToken) return "";

  const withProtocol = /^https?:\/\//i.test(firstToken)
    ? firstToken
    : `https://${firstToken}`;

  try {
    return new URL(withProtocol).toString();
  } catch {
    return "";
  }
}

function showLocalFulfilledScreen(order) {
  const trackingNumber = String(order?.fulfillment_number || "").trim();
  const trackingUrl = normalizeTrackingUrl(order?.tracking_url);

  if (localFulfilledTrackingLabel) {
    localFulfilledTrackingLabel.hidden = !trackingNumber;
  }

  if (localFulfilledTrackingNumber) {
    if (trackingNumber) {
      localFulfilledTrackingNumber.textContent = trackingNumber;
      localFulfilledTrackingNumber.hidden = false;
    } else {
      localFulfilledTrackingNumber.textContent = "";
      localFulfilledTrackingNumber.hidden = true;
    }
  }

  if (localFulfilledTrackingBtn) {
    if (trackingUrl) {
      localFulfilledTrackingBtn.dataset.url = trackingUrl;
      localFulfilledTrackingBtn.hidden = false;
    } else {
      localFulfilledTrackingBtn.dataset.url = "";
      localFulfilledTrackingBtn.hidden = true;
    }
  }

  showStatusScreen(localFulfilledScreen);
}

function hasLocalTag(tags) {
  return String(tags || "").toLowerCase().includes("local");
}

function hasForaneoTag(tags) {
  return String(tags || "").toLowerCase().includes("foraneo");
}

function isLocalFulfilledStatus(status) {
  const value = String(status || "").toLowerCase().trim();
  return value === "fulfilled" || value === "partially" || value.includes("partially");
}

async function lookupOrder(payload) {
  const response = await fetch(LOOKUP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "No se pudo consultar el pedido.");
  }

  return data;
}

phoneInput.addEventListener("input", (event) => {
  applyPhoneValue(event.target.value);
  updateButtonState();
});

phoneInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;

  event.preventDefault();
  if (validatePhoneWithToast()) {
    orderInput.focus();
  }
});

phoneInput.addEventListener("blur", () => {
  if (phoneDigits.length > 0 && !isPhoneValid()) {
    validatePhoneWithToast();
  }
});

orderInput.addEventListener("input", (event) => {
  applyOrderValue(event.target.value);
  placeCursorAtOrderEnd();
  updateButtonState();
});

orderInput.addEventListener("blur", () => {
  if (orderDigits.length > 0 && !isOrderValid()) {
    validateOrderWithToast();
  }
});

orderInput.addEventListener("focus", () => {
  applyOrderValue(orderInput.value);
  placeCursorAtOrderEnd();
});

orderInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;

  event.preventDefault();
  if (!validatePhoneWithToast()) {
    phoneInput.focus();
    return;
  }

  if (validateOrderWithToast()) {
    trackingForm.requestSubmit();
  }
});

if (localFulfilledTrackingBtn) {
  localFulfilledTrackingBtn.addEventListener("click", () => {
    const url = localFulfilledTrackingBtn.dataset.url || "";
    if (!url) {
      showToast("Aún no tenemos un link de rastreo para este pedido.");
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  });
}

if (localFulfilledTrackingNumber) {
  localFulfilledTrackingNumber.addEventListener("click", async () => {
    const trackingNumber = localFulfilledTrackingNumber.textContent?.trim() || "";
    if (!trackingNumber) {
      showToast("Aún no tenemos número de rastreo para este pedido.");
      return;
    }

    const copied = await copyTextToClipboard(trackingNumber);
    if (copied) {
      showToast("Número copiado en el portapapeles");
    } else {
      showToast("No se pudo copiar el número.");
    }
  });
}

trackingForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!validatePhoneWithToast()) {
    phoneInput.focus();
    return;
  }

  if (!validateOrderWithToast()) {
    orderInput.focus();
    return;
  }

  const payload = {
    phone: phoneDigits,
    orderNumber: orderInput.value,
  };

  try {
    setSubmittingState(true);
    const result = await lookupOrder(payload);

    if (!result.found) {
      showToast("No encontramos un pedido con esos datos.");
      return;
    }

    sessionStorage.setItem("stashx_last_order_lookup", JSON.stringify(result.order));

    const financialStatus = String(result.order.financial_status || "").toLowerCase();
    if (financialStatus !== "paid") {
      showPendingScreen();
      return;
    }

    const fulfillmentStatus = String(result.order.fulfillment_status || "").toLowerCase();
    if (hasLocalTag(result.order.tags)) {
      if (isLocalFulfilledStatus(fulfillmentStatus)) {
        showLocalFulfilledScreen(result.order);
      } else {
        showLocalPreparingScreen();
      }
      return;
    }

    if (hasForaneoTag(result.order.tags) && !isLocalFulfilledStatus(fulfillmentStatus)) {
      showForaneoPreparingScreen();
      return;
    }

    showToast("Pedido encontrado. Continuamos con la siguiente pantalla.");
  } catch (error) {
    showToast(error.message || "No se pudo consultar el pedido.");
  } finally {
    setSubmittingState(false);
  }
});

prefillFromUrlParams();
updateButtonState();

window.addEventListener("load", () => {
  if (phoneInput.value.length === 0) {
    phoneInput.focus();
  }
});
