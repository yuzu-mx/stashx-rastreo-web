import { Pool } from "pg";

const REQUIRED_ENV = ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"];
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "latest";
const SHOPIFY_DOMAIN_ENV_KEYS = [
  "SHOPIFY_SHOP_DOMAIN",
  "SHOPIFY_STORE_DOMAIN",
  "SHOPIFY_DOMAIN",
  "SHOPIFY_STORE_URL",
];
const SHOPIFY_TOKEN_ENV_KEYS = ["SHOPIFY_API_KEY", "SHOPIFY_ACCESS_TOKEN", "SHOPIFY_ADMIN_API_TOKEN"];

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

function getShopifyShopDomain() {
  for (const key of SHOPIFY_DOMAIN_ENV_KEYS) {
    const domain = normalizeShopDomain(process.env[key]);
    if (domain) return domain;
  }
  return "";
}

function getShopifyAccessToken() {
  for (const key of SHOPIFY_TOKEN_ENV_KEYS) {
    const token = String(process.env[key] || "").trim();
    if (token) return token;
  }
  return "";
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

function extractTrackingEntries(fulfillment) {
  const entries = [];
  const directCompany = String(fulfillment?.tracking_company || "").trim();
  const pushEntry = (number, url, company = "") => {
    const normalizedNumber = String(number || "").trim();
    const normalizedUrl = normalizeTrackingUrl(url);
    const normalizedCompany = String(company || "").trim();

    if (!normalizedNumber && !normalizedUrl) return;
    entries.push({
      number: normalizedNumber,
      url: normalizedUrl,
      company: normalizedCompany || directCompany,
    });
  };

  const trackingInfoSnake = Array.isArray(fulfillment?.tracking_info)
    ? fulfillment.tracking_info
    : [];
  trackingInfoSnake.forEach((info) => {
    pushEntry(info?.number, info?.url || info?.tracking_url, info?.company);
  });

  const trackingInfoCamel = Array.isArray(fulfillment?.trackingInfo)
    ? fulfillment.trackingInfo
    : [];
  trackingInfoCamel.forEach((info) => {
    pushEntry(info?.number, info?.url || info?.trackingUrl, info?.company);
  });

  const directNumbers = [
    String(fulfillment?.tracking_number || "").trim(),
    ...(Array.isArray(fulfillment?.tracking_numbers)
      ? fulfillment.tracking_numbers.map((value) => String(value || "").trim())
      : []),
  ].filter(Boolean);

  const directUrls = [
    fulfillment?.tracking_url,
    ...(Array.isArray(fulfillment?.tracking_urls) ? fulfillment.tracking_urls : []),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (directNumbers.length || directUrls.length) {
    const rowCount = Math.max(directNumbers.length || 1, directUrls.length || 1);
    for (let index = 0; index < rowCount; index += 1) {
      pushEntry(
        directNumbers[index] || directNumbers[0] || "",
        directUrls[index] || directUrls[0] || "",
        directCompany
      );
    }
  }

  return entries;
}

function pickPrimaryTrackingNumber(fulfillment) {
  const trackingEntries = extractTrackingEntries(fulfillment);
  const primaryFromEntry = trackingEntries.find((entry) => entry.number);
  if (primaryFromEntry) return primaryFromEntry.number;

  const direct = String(fulfillment?.tracking_number || "").trim();
  if (direct) return direct;
  if (Array.isArray(fulfillment?.tracking_numbers) && fulfillment.tracking_numbers.length > 0) {
    return String(fulfillment.tracking_numbers[0] || "").trim();
  }
  return "";
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
  const shopDomain = getShopifyShopDomain();
  const accessToken = getShopifyAccessToken();
  if (!shopDomain || !accessToken || !shopifyOrderId) {
    return {
      fulfillments: [],
      reason: "missing_shopify_config_or_order_id",
    };
  }

  const commonHeaders = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  const directFulfillmentsEndpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/fulfillments.json?limit=250`;
  const directResponse = await fetch(directFulfillmentsEndpoint, {
    method: "GET",
    headers: commonHeaders,
  });

  if (directResponse.ok) {
    const payload = await directResponse.json().catch(() => ({}));
    const fulfillments = Array.isArray(payload.fulfillments) ? payload.fulfillments : [];
    if (fulfillments.length > 0) {
      return { fulfillments, reason: "fulfillments_endpoint" };
    }
  }

  const orderEndpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}.json?fields=id,fulfillments`;
  const orderResponse = await fetch(orderEndpoint, {
    method: "GET",
    headers: commonHeaders,
  });

  if (orderResponse.ok) {
    const orderPayload = await orderResponse.json().catch(() => ({}));
    const fulfillments = Array.isArray(orderPayload?.order?.fulfillments)
      ? orderPayload.order.fulfillments
      : [];
    if (fulfillments.length > 0) {
      return {
        fulfillments,
        reason: "order_endpoint",
      };
    }
  }

  const graphQlEndpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const graphQlQuery = `
    query OrderFulfillments($id: ID!) {
      order(id: $id) {
        fulfillments(first: 50) {
          nodes {
            status
            shipmentStatus
            trackingInfo {
              number
              url
              company
            }
          }
        }
      }
    }
  `;

  let graphQlStatus = 0;
  let graphQlReason = "graphql_not_attempted";

  try {
    const graphQlResponse = await fetch(graphQlEndpoint, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({
        query: graphQlQuery,
        variables: {
          id: `gid://shopify/Order/${shopifyOrderId}`,
        },
      }),
    });

    graphQlStatus = graphQlResponse.status;

    if (graphQlResponse.ok) {
      const payload = await graphQlResponse.json().catch(() => ({}));
      const errors = Array.isArray(payload?.errors) ? payload.errors : [];
      if (!errors.length) {
        const fulfillments = Array.isArray(payload?.data?.order?.fulfillments?.nodes)
          ? payload.data.order.fulfillments.nodes
          : [];
        if (fulfillments.length > 0) {
          return {
            fulfillments,
            reason: "graphql_order_fulfillments",
          };
        }
        graphQlReason = "graphql_no_fulfillments";
      } else {
        graphQlReason = `graphql_errors:${errors.map((error) => error?.message).filter(Boolean).join(" | ")}`;
      }
    } else {
      graphQlReason = `graphql_http_${graphQlResponse.status}`;
    }
  } catch (error) {
    graphQlReason = `graphql_fetch_failed:${String(error?.message || "unknown")}`;
  }

  if (!directResponse.ok && !orderResponse.ok && graphQlStatus >= 400) {
    const statusSummary = `fulfillments:${directResponse.status};order:${orderResponse.status};graphql:${graphQlStatus}`;
    throw new Error(`Shopify lookup failed (${statusSummary})`);
  }

  return {
    fulfillments: [],
    reason: graphQlReason || "no_fulfillments_found",
  };
}

function selectTrackingFromFulfillments(fulfillments, expectedTrackingNumber) {
  const expectedTokens = toTrackingTokens(expectedTrackingNumber);

  const normalized = fulfillments
    .map((fulfillment) => {
      const trackingEntries = extractTrackingEntries(fulfillment);
      const primaryTrackingNumber = pickPrimaryTrackingNumber(fulfillment);
      const tokens = new Set([
        ...toTrackingTokens(primaryTrackingNumber),
        ...(Array.isArray(fulfillment?.tracking_numbers)
          ? fulfillment.tracking_numbers.flatMap((value) => toTrackingTokens(value))
          : []),
        ...trackingEntries.flatMap((entry) => toTrackingTokens(entry.number)),
      ]);

      const trackingUrl =
        trackingEntries.map((entry) => entry.url).find(Boolean) ||
        normalizeTrackingUrl(
          fulfillment?.tracking_url ||
            (Array.isArray(fulfillment?.tracking_urls) ? fulfillment.tracking_urls[0] : "")
        );
      const status = String(fulfillment?.status || fulfillment?.shipment_status || "")
        .toLowerCase()
        .trim();

      return {
        fulfillment,
        status,
        tokens: Array.from(tokens),
        trackingUrl,
      };
    })
    .filter((item) => item.trackingUrl)
    .reverse();

  if (!normalized.length) {
    return { tracking_url: "", fulfillment_number: "" };
  }

  const hasMatchingToken = (item) =>
    expectedTokens.length > 0 && item.tokens.some((token) => expectedTokens.includes(token));
  const isPreferredStatus = (status) =>
    status === "success" ||
    status === "open" ||
    status === "closed" ||
    status.includes("in_transit") ||
    status.includes("out_for_delivery") ||
    status.includes("delivered");

  const preferredByTokenAndStatus = normalized.find(
    (item) => hasMatchingToken(item) && isPreferredStatus(item.status)
  );
  if (preferredByTokenAndStatus) {
    return {
      tracking_url: preferredByTokenAndStatus.trackingUrl,
      fulfillment_number:
        pickPrimaryTrackingNumber(preferredByTokenAndStatus.fulfillment) ||
        expectedTrackingNumber ||
        "",
    };
  }

  const preferredByToken = normalized.find((item) => hasMatchingToken(item));
  if (preferredByToken) {
    return {
      tracking_url: preferredByToken.trackingUrl,
      fulfillment_number: pickPrimaryTrackingNumber(preferredByToken.fulfillment) || expectedTrackingNumber || "",
    };
  }

  const preferredByStatus = normalized.find((item) => isPreferredStatus(item.status)) || normalized[0];
  return {
    tracking_url: preferredByStatus.trackingUrl,
    fulfillment_number: pickPrimaryTrackingNumber(preferredByStatus.fulfillment) || expectedTrackingNumber || "",
  };
}

function buildTrackingLookupDebug() {
  return {
    attempted: false,
    shopify_order_id: "",
    fulfillments_found: 0,
    resolved: false,
    source: "",
    reason: "",
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
      const trackingLookup = buildTrackingLookupDebug();
      trackingLookup.attempted = true;
      trackingLookup.shopify_order_id = parseShopifyOrderId(order.shopify_id);
      trackingLookup.source = "database";

      if (trackingLookup.shopify_order_id) {
        try {
          const fetched = await fetchOrderFulfillmentsFromShopify(trackingLookup.shopify_order_id);
          trackingLookup.reason = fetched.reason;
          trackingLookup.fulfillments_found = fetched.fulfillments.length;

          const resolved = selectTrackingFromFulfillments(fetched.fulfillments, order.fulfillment_number);
          if (resolved.tracking_url) {
            order.tracking_url = resolved.tracking_url;
            trackingLookup.resolved = true;
            trackingLookup.source = "shopify";
          }
          if (resolved.fulfillment_number) {
            order.fulfillment_number = resolved.fulfillment_number;
          }
        } catch (error) {
          trackingLookup.reason = String(error?.message || "shopify_lookup_failed");
          console.error("shopify fulfillments lookup error", error);
        }
      } else {
        trackingLookup.reason = "missing_shopify_order_id";
      }

      order.tracking_lookup = trackingLookup;
    }

    order.tracking_url = normalizeTrackingUrl(order.tracking_url);
    return jsonResponse({ found: true, order }, 200);
  } catch (error) {
    console.error("order-lookup error", error);
    return jsonResponse({ error: "No se pudo consultar el pedido." }, 500);
  }
};
