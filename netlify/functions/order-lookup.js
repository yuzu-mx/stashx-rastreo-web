import { Pool } from "pg";

const REQUIRED_ENV = ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"];
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
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

async function shopifyGraphQLRequest(shopDomain, accessToken, query, variables) {
  const endpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json().catch(() => ({}));
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];

  return {
    ok: response.ok,
    status: response.status,
    data: payload?.data || null,
    errors,
  };
}

function mapGraphQlFulfillment(fulfillment) {
  const trackingInfo = Array.isArray(fulfillment?.trackingInfo) ? fulfillment.trackingInfo : [];
  const trackingNumbers = trackingInfo.map((item) => String(item?.number || "").trim()).filter(Boolean);
  const trackingUrls = trackingInfo.map((item) => String(item?.url || "").trim()).filter(Boolean);
  const primaryNumber = trackingNumbers[0] || "";
  const primaryUrl = trackingUrls[0] || "";

  return {
    status: String(fulfillment?.status || "").toLowerCase().trim(),
    shipment_status: String(fulfillment?.shipmentStatus || "").toLowerCase().trim(),
    created_at: String(fulfillment?.createdAt || ""),
    updated_at: String(fulfillment?.updatedAt || fulfillment?.createdAt || ""),
    trackingInfo,
    tracking_info: trackingInfo,
    tracking_number: primaryNumber,
    tracking_numbers: trackingNumbers,
    tracking_url: primaryUrl,
    tracking_urls: trackingUrls,
  };
}

function normalizeGraphQlOrderName(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^#/, "");
}

function buildOrderLookupQuery(orderNumber) {
  const raw = String(orderNumber || "").trim();
  if (!raw) return "";
  const escaped = raw.replace(/"/g, '\\"');
  return `name:${escaped}`;
}

async function fetchOrderFulfillmentsFromShopify(shopifyOrderId, orderNumber) {
  const shopDomain = getShopifyShopDomain();
  const accessToken = getShopifyAccessToken();
  if (!shopDomain || !accessToken) {
    return {
      fulfillments: [],
      reason: "missing_shopify_config",
      debug: {
        mode: "graphql_only",
        by_id: {
          attempted: false,
          status: 0,
          errors: [],
          order_found: false,
          fulfillments: 0,
        },
        by_name: {
          attempted: false,
          status: 0,
          errors: [],
          order_found: false,
          candidates: 0,
          fulfillments: 0,
        },
      },
    };
  }

  const debug = {
    mode: "graphql_only",
    by_id: {
      attempted: false,
      status: 0,
      errors: [],
      order_found: false,
      fulfillments: 0,
      order_gid: "",
      order_name: "",
    },
    by_name: {
      attempted: false,
      status: 0,
      errors: [],
      order_found: false,
      candidates: 0,
      fulfillments: 0,
      order_gid: "",
      order_name: "",
      query: "",
    },
  };

  const byIdQuery = `
    query OrderFulfillmentsById($id: ID!) {
      order(id: $id) {
        id
        name
        legacyResourceId
        fulfillments {
            id
            status
            shipmentStatus
            createdAt
            updatedAt
            trackingInfo {
              number
              url
              company
            }
        }
      }
    }
  `;

  const parsedOrderId = parseShopifyOrderId(shopifyOrderId);
  if (parsedOrderId) {
    debug.by_id.attempted = true;
    const byIdResult = await shopifyGraphQLRequest(shopDomain, accessToken, byIdQuery, {
      id: `gid://shopify/Order/${parsedOrderId}`,
    });

    debug.by_id.status = byIdResult.status;
    debug.by_id.errors = byIdResult.errors.map((error) => String(error?.message || "")).filter(Boolean);

    const byIdOrder = byIdResult.data?.order || null;
    if (byIdOrder) {
      const fulfillmentNodes = Array.isArray(byIdOrder?.fulfillments)
        ? byIdOrder.fulfillments
        : Array.isArray(byIdOrder?.fulfillments?.nodes)
          ? byIdOrder.fulfillments.nodes
          : [];
      const fulfillments = fulfillmentNodes.map(mapGraphQlFulfillment);
      debug.by_id.order_found = true;
      debug.by_id.fulfillments = fulfillments.length;
      debug.by_id.order_gid = String(byIdOrder?.id || "");
      debug.by_id.order_name = String(byIdOrder?.name || "");

      if (fulfillments.length > 0) {
        return {
          fulfillments,
          reason: "graphql_by_id",
          debug,
        };
      }
    }
  }

  const byNameQuery = `
    query OrderFulfillmentsByName($query: String!) {
      orders(first: 10, query: $query, sortKey: PROCESSED_AT, reverse: true) {
        nodes {
          id
          name
          legacyResourceId
          fulfillments {
              id
              status
              shipmentStatus
              createdAt
              updatedAt
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

  const searchQuery = buildOrderLookupQuery(orderNumber);
  if (!searchQuery) {
    return {
      fulfillments: [],
      reason: "graphql_missing_search_query",
      debug,
    };
  }

  debug.by_name.attempted = true;
  debug.by_name.query = searchQuery;

  const byNameResult = await shopifyGraphQLRequest(shopDomain, accessToken, byNameQuery, {
    query: searchQuery,
  });

  debug.by_name.status = byNameResult.status;
  debug.by_name.errors = byNameResult.errors.map((error) => String(error?.message || "")).filter(Boolean);

  const nodes = Array.isArray(byNameResult.data?.orders?.nodes) ? byNameResult.data.orders.nodes : [];
  debug.by_name.candidates = nodes.length;

  const expectedName = normalizeGraphQlOrderName(orderNumber);
  const selectedOrder =
    nodes.find((node) => String(node?.legacyResourceId || "") === String(parsedOrderId || "")) ||
    nodes.find((node) => normalizeGraphQlOrderName(node?.name) === expectedName) ||
    nodes.find((node) => normalizeGraphQlOrderName(node?.name).includes(expectedName)) ||
    nodes[0] ||
    null;

  if (!selectedOrder) {
    return {
      fulfillments: [],
      reason: "graphql_order_not_found",
      debug,
    };
  }

  const selectedFulfillmentNodes = Array.isArray(selectedOrder?.fulfillments)
    ? selectedOrder.fulfillments
    : Array.isArray(selectedOrder?.fulfillments?.nodes)
      ? selectedOrder.fulfillments.nodes
      : [];
  const fulfillments = selectedFulfillmentNodes.map(mapGraphQlFulfillment);

  debug.by_name.order_found = true;
  debug.by_name.fulfillments = fulfillments.length;
  debug.by_name.order_gid = String(selectedOrder?.id || "");
  debug.by_name.order_name = String(selectedOrder?.name || "");

  if (!fulfillments.length) {
    return {
      fulfillments: [],
      reason: "graphql_order_without_fulfillments",
      debug,
    };
  }

  return {
    fulfillments,
    reason: "graphql_by_name",
    debug,
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
    mode: "",
    by_id: null,
    by_name: null,
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
          const fetched = await fetchOrderFulfillmentsFromShopify(
            trackingLookup.shopify_order_id,
            order.order_name
          );
          trackingLookup.reason = fetched.reason;
          trackingLookup.fulfillments_found = fetched.fulfillments.length;
          trackingLookup.mode = fetched.debug?.mode || "graphql_only";
          trackingLookup.by_id = fetched.debug?.by_id || null;
          trackingLookup.by_name = fetched.debug?.by_name || null;

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
