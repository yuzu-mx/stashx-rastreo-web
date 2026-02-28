import { Pool } from "pg";

const REQUIRED_ENV = ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"];
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "latest";

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

function normalizeShopDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .split("/")[0];
}

function normalizeTrackingUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return "";
  }
}

function normalizeTrackingToken(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function toTrackingTokens(value) {
  return String(value || "")
    .split(/[,\s;/|]+/)
    .map((token) => normalizeTrackingToken(token))
    .filter(Boolean);
}

function parseShopifyOrderId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return raw;

  const gidMatch = raw.match(/(\d+)(?!.*\d)/);
  return gidMatch ? gidMatch[1] : "";
}

function hasTag(tags, expectedTag) {
  return String(tags || "").toLowerCase().includes(String(expectedTag || "").toLowerCase());
}

function isFulfilledStatus(value) {
  const normalized = String(value || "").toLowerCase().trim();
  return normalized === "fulfilled" || normalized === "partially" || normalized.includes("partially");
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
    jt_url,
    shopify_id
  FROM public.orders_full
  WHERE upper(trim(COALESCE(name, ''))) = $1
    AND regexp_replace(COALESCE(shipping_phone, ''), '\\D', '', 'g') ILIKE '%' || $2 || '%'
  ORDER BY created_at DESC NULLS LAST
  LIMIT 1
`;

async function fetchOrderFulfillmentsFromShopify(shopifyOrderId) {
  const shopDomain = normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN);
  const accessToken = String(
    process.env.SHOPIFY_API_KEY || process.env.SHOPIFY_ACCESS_TOKEN || ""
  ).trim();
  if (!shopDomain || !accessToken || !shopifyOrderId) {
    return [];
  }

  const endpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/fulfillments.json?limit=250`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Shopify fulfillments lookup failed (${response.status})`);
  }

  const payload = await response.json().catch(() => ({}));
  return Array.isArray(payload.fulfillments) ? payload.fulfillments : [];
}

function selectTrackingFromFulfillments(fulfillments, expectedTrackingNumber) {
  const expectedTokens = toTrackingTokens(expectedTrackingNumber);

  const normalized = fulfillments
    .map((fulfillment) => {
      const tokens = new Set([
        ...toTrackingTokens(fulfillment?.tracking_number),
        ...(Array.isArray(fulfillment?.tracking_numbers)
          ? fulfillment.tracking_numbers.flatMap((value) => toTrackingTokens(value))
          : []),
      ]);

      const trackingUrl = normalizeTrackingUrl(
        fulfillment?.tracking_url ||
          (Array.isArray(fulfillment?.tracking_urls) ? fulfillment.tracking_urls[0] : "")
      );

      return {
        fulfillment,
        status: String(fulfillment?.status || "").toLowerCase(),
        tokens: Array.from(tokens),
        trackingUrl,
      };
    })
    .filter((item) => item.trackingUrl);

  if (!normalized.length) {
    return { tracking_url: "", fulfillment_number: "" };
  }

  const hasMatchingToken = (item) =>
    expectedTokens.length > 0 && item.tokens.some((token) => expectedTokens.includes(token));

  const preferredByTokenAndStatus = normalized.find(
    (item) => hasMatchingToken(item) && (item.status === "success" || item.status === "open")
  );
  if (preferredByTokenAndStatus) {
    return {
      tracking_url: preferredByTokenAndStatus.trackingUrl,
      fulfillment_number:
        preferredByTokenAndStatus.fulfillment?.tracking_number || expectedTrackingNumber || "",
    };
  }

  const preferredByToken = normalized.find((item) => hasMatchingToken(item));
  if (preferredByToken) {
    return {
      tracking_url: preferredByToken.trackingUrl,
      fulfillment_number: preferredByToken.fulfillment?.tracking_number || expectedTrackingNumber || "",
    };
  }

  const preferredByStatus = normalized.find((item) => item.status === "success") || normalized[0];
  return {
    tracking_url: preferredByStatus.trackingUrl,
    fulfillment_number: preferredByStatus.fulfillment?.tracking_number || expectedTrackingNumber || "",
  };
}

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

    const order = rows[0];
    const shouldResolveForaneoTracking =
      hasTag(order.tags, "foraneo") && isFulfilledStatus(order.fulfillment_status);

    if (shouldResolveForaneoTracking) {
      const shopifyOrderId = parseShopifyOrderId(order.shopify_id);
      if (shopifyOrderId) {
        try {
          const fulfillments = await fetchOrderFulfillmentsFromShopify(shopifyOrderId);
          const resolved = selectTrackingFromFulfillments(fulfillments, order.fulfillment_number);
          if (resolved.tracking_url) {
            order.tracking_url = resolved.tracking_url;
          }
          if (resolved.fulfillment_number) {
            order.fulfillment_number = resolved.fulfillment_number;
          }
        } catch (error) {
          console.error("shopify fulfillments lookup error", error);
        }
      }
    }

    return jsonResponse({ found: true, order }, 200);
  } catch (error) {
    console.error("order-lookup error", error);
    return jsonResponse({ error: "No se pudo consultar el pedido." }, 500);
  }
};
