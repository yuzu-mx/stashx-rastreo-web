import { Pool } from "pg";

const REQUIRED_ENV = ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"];

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl:
    process.env.PGSSLMODE && process.env.PGSSLMODE.toLowerCase() === "disable"
      ? false
      : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function normalizeOrder(value) {
  return String(value || "").trim().toUpperCase();
}

function validatePayload(phone, orderNumber) {
  if (!/^\d{10}$/.test(phone)) {
    return "El teléfono debe tener exactamente 10 dígitos.";
  }

  if (!/^ST-\d{3,9}$/.test(orderNumber)) {
    return "El número de pedido debe tener formato ST-XXX.";
  }

  return "";
}

const LOOKUP_QUERY = `
  SELECT
    name AS order_name,
    shipping_phone AS phone,
    tags,
    financial_status,
    fulfillment_status,
    tracking_url,
    fulfillment_number,
    created_at,
    paid_at,
    onfleet_created_at,
    onfleet_delivered_at,
    onfleet_failed_at,
    lalamove_delivered_at,
    shipping_type,
    full_address,
    notes,
    jt_label_url,
    jt_url
  FROM public.orders_full
  WHERE upper(trim(COALESCE(name, ''))) = $1
    AND regexp_replace(COALESCE(shipping_phone, ''), '\\D', '', 'g') ILIKE '%' || $2 || '%'
  ORDER BY created_at DESC NULLS LAST
  LIMIT 1
`;

export default async (request) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Método no permitido" }, 405);
  }

  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    return jsonResponse(
      {
        error: `Faltan variables de entorno: ${missing.join(", ")}`,
      },
      500
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Body JSON inválido" }, 400);
  }

  const phone = normalizePhone(payload.phone);
  const orderNumber = normalizeOrder(payload.orderNumber);

  const validationError = validatePayload(phone, orderNumber);
  if (validationError) {
    return jsonResponse({ error: validationError }, 400);
  }

  try {
    const { rows } = await pool.query(LOOKUP_QUERY, [orderNumber, phone]);
    if (!rows.length) {
      return jsonResponse({ found: false, order: null }, 200);
    }

    return jsonResponse({ found: true, order: rows[0] }, 200);
  } catch (error) {
    console.error("order-lookup error", error);
    return jsonResponse({ error: "No se pudo consultar el pedido." }, 500);
  }
};
