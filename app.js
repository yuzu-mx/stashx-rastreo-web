const trackingForm = document.getElementById("trackingForm");
const phoneInput = document.getElementById("phoneInput");
const orderInput = document.getElementById("orderInput");
const searchOrderBtn = document.getElementById("searchOrderBtn");
const toastRegion = document.getElementById("toastRegion");

let phoneDigits = "";
let orderDigits = "";
let lastToast = { message: "", time: 0 };

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
  searchOrderBtn.disabled = !(isPhoneValid() && isOrderValid());
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

trackingForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!validatePhoneWithToast()) {
    phoneInput.focus();
    return;
  }

  if (!validateOrderWithToast()) {
    orderInput.focus();
    return;
  }

  showToast("Datos listos. Siguiente paso: conectar búsqueda de pedido.");

  const payload = {
    phone: phoneDigits,
    orderNumber: orderInput.value,
  };

  console.log("Tracking form valid:", payload);
});

window.addEventListener("load", () => {
  setTimeout(() => {
    phoneInput.focus();
    const cursor = phoneInput.value.length;
    phoneInput.setSelectionRange(cursor, cursor);
  }, 100);
});
