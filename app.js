const lookupScreen = document.getElementById("lookupScreen");
const pendingScreen = document.getElementById("pendingScreen");
const pendingProgressValue = document.getElementById("pendingProgressValue");
const trackingForm = document.getElementById("trackingForm");
const phoneInput = document.getElementById("phoneInput");
const orderInput = document.getElementById("orderInput");
const searchOrderBtn = document.getElementById("searchOrderBtn");
const toastRegion = document.getElementById("toastRegion");

const LOOKUP_ENDPOINT = "/.netlify/functions/order-lookup";

let phoneDigits = "";
let orderDigits = "";
let lastToast = { message: "", time: 0 };
let isSubmitting = false;
let pendingProgressRaf = null;

function formatPhone(digits) {
  if (digits.length <= 2) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}`;
}

function isPhoneValid() {
  return phoneDigits.length === 10;
}

function isOrderValid() {
  return /^ST-\d{3,9}$/.test(orderInput.value);
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
    showToast("El pedido debe iniciar con ST- y tener al menos 3 números.");
    return false;
  }
  return true;
}

function animatePendingProgressValue(target = 10, durationMs = 1000) {
  if (!pendingProgressValue) return;
  if (pendingProgressRaf) {
    cancelAnimationFrame(pendingProgressRaf);
    pendingProgressRaf = null;
  }

  pendingProgressValue.textContent = "0%";
  const start = performance.now();

  const tick = (now) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / durationMs, 1);
    const value = Math.round(target * progress);
    pendingProgressValue.textContent = `${value}%`;

    if (progress < 1) {
      pendingProgressRaf = requestAnimationFrame(tick);
      return;
    }

    pendingProgressValue.textContent = `${target}%`;
    pendingProgressRaf = null;
  };

  pendingProgressRaf = requestAnimationFrame(tick);
}

function showPendingScreen() {
  lookupScreen.hidden = true;
  pendingScreen.hidden = false;
  pendingScreen.classList.remove("is-animating");
  void pendingScreen.offsetWidth;
  pendingScreen.classList.add("is-animating");
  animatePendingProgressValue(10, 1000);
  window.scrollTo({ top: 0, behavior: "auto" });
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
  phoneDigits = event.target.value.replace(/\D/g, "").slice(0, 10);
  phoneInput.value = formatPhone(phoneDigits);
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
  const raw = event.target.value.toUpperCase();
  const cleaned = raw.replace(/[^ST0-9-]/g, "");
  orderDigits = cleaned.replace(/\D/g, "").slice(0, 9);

  if (cleaned.length === 0) {
    orderInput.value = "";
  } else {
    orderInput.value = `ST-${orderDigits}`;
  }

  updateButtonState();
});

orderInput.addEventListener("blur", () => {
  if (orderInput.value.length > 0 && !isOrderValid()) {
    validateOrderWithToast();
  }
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

    showToast("Pedido encontrado. Continuamos con la siguiente pantalla.");
    console.log("Order lookup result:", result.order);
  } catch (error) {
    showToast(error.message || "Ocurrió un error al buscar el pedido.");
  } finally {
    setSubmittingState(false);
  }
});

window.addEventListener("load", () => {
  setTimeout(() => {
    phoneInput.focus();
    const cursor = phoneInput.value.length;
    phoneInput.setSelectionRange(cursor, cursor);
  }, 100);
});
