function getUserFromContext(context) {
  const user = context.clientContext && context.clientContext.user;
  return user || null;
}

async function getUserFromIdentity(request) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;

  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!siteUrl) return null;

  try {
    const response = await fetch(`${siteUrl}/.netlify/identity/user`, {
      headers: {
        Authorization: auth,
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function isAllowedEmail(email) {
  const baseId = process.env.AIRTABLE_BASE;
  const adminTable = process.env.AIRTABLE_ADMIN_TABLE;
  const token = process.env.AIRTABLE_TOKEN;

  if (!baseId || !adminTable || !token) return false;

  const formula = `LOWER({Email})='${email.toLowerCase()}'`;
  const url = new URL(`https://api.airtable.com/v0/${baseId}/${adminTable}`);
  url.searchParams.set("filterByFormula", formula);
  url.searchParams.set("maxRecords", "1");

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return false;

  const data = await response.json();
  return (data.records || []).length > 0;
}

async function fetchRecords() {
  const baseId = process.env.AIRTABLE_BASE;
  const tableName = process.env.AIRTABLE_TABLE;
  const token = process.env.AIRTABLE_TOKEN;

  const records = [];
  let offset = "";

  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableName}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText);
    }

    const data = await response.json();
    records.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);

  return records;
}

function mapRecord(record) {
  const fields = record.fields || {};
  const imageField = fields.Images && fields.Images[0] && fields.Images[0].url;
  const rawGender = fields["Gender"];
  const genderValue = Array.isArray(rawGender)
    ? rawGender.join(", ")
    : rawGender && typeof rawGender === "object"
      ? rawGender.name || rawGender.value || rawGender.text || rawGender.result || ""
      : rawGender || "";
  return {
    id: record.id,
    album: fields["Album Name"] || "",
    artist: fields["Artist"] || "",
    year: fields["Album Year"] || "",
    status: fields["Status"] || "",
    gift: fields["Gift"] || "",
    gender: genderValue,
    image: imageField || "",
  };
}

async function createRecord(payload) {
  const baseId = process.env.AIRTABLE_BASE;
  const tableName = process.env.AIRTABLE_TABLE;
  const token = process.env.AIRTABLE_TOKEN;

  const fields = {
    "Album Name": payload.album || "",
    Artist: payload.artist || "",
  };

  if (payload.year) {
    fields["Album Year"] = String(payload.year);
  }

  if (payload.status) {
    fields.Status = payload.status;
  }
  if (payload.gift) {
    fields.Gift = payload.gift;
  }

  if (payload.image) {
    fields.Images = [{ url: payload.image }];
  }

  const response = await fetch(`https://api.airtable.com/v0/${baseId}/${tableName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText);
  }

  return response.json();
}

async function updateRecord(payload) {
  const baseId = process.env.AIRTABLE_BASE;
  const tableName = process.env.AIRTABLE_TABLE;
  const token = process.env.AIRTABLE_TOKEN;

  const fields = {
    "Album Name": payload.album || "",
    Artist: payload.artist || "",
  };

  if (payload.year) {
    fields["Album Year"] = String(payload.year);
  }

  if (payload.status) {
    fields.Status = payload.status;
  }
  if (payload.gift) {
    fields.Gift = payload.gift;
  }

  if (payload.image) {
    fields.Images = [{ url: payload.image }];
  }

  const response = await fetch(`https://api.airtable.com/v0/${baseId}/${tableName}/${payload.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText);
  }

  return response.json();
}

async function deleteRecord(payload) {
  const baseId = process.env.AIRTABLE_BASE;
  const tableName = process.env.AIRTABLE_TABLE;
  const token = process.env.AIRTABLE_TOKEN;

  const response = await fetch(`https://api.airtable.com/v0/${baseId}/${tableName}/${payload.id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText);
  }

  return response.json();
}

export default async (request, context) => {
  let user = getUserFromContext(context);
  if (!user || !user.email) {
    user = await getUserFromIdentity(request);
  }

  if (!user || !user.email) {
    return jsonResponse({ error: "No autorizado" }, 401);
  }

  const allowed = await isAllowedEmail(user.email);
  if (!allowed) {
    return jsonResponse({ error: "No autorizado" }, 403);
  }

  if (request.method === "GET") {
    const records = await fetchRecords();
    return jsonResponse({
      allowed: true,
      email: user.email,
      records: records.map(mapRecord),
    });
  }

  const payload = await request.json();

  try {
    if (request.method === "POST") {
      await createRecord(payload);
      return jsonResponse({ ok: true });
    }

    if (request.method === "PATCH") {
      await updateRecord(payload);
      return jsonResponse({ ok: true });
    }

    if (request.method === "DELETE") {
      await deleteRecord(payload);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Método no permitido" }, 405);
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
};
