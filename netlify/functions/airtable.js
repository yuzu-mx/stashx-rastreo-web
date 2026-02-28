export default async (request, context) => {
  const baseId = process.env.AIRTABLE_BASE;
  const tableName = process.env.AIRTABLE_TABLE;
  const token = process.env.AIRTABLE_TOKEN;

  if (!baseId || !tableName || !token) {
    return new Response(
      JSON.stringify({ error: "Configura AIRTABLE_BASE, AIRTABLE_TABLE y AIRTABLE_TOKEN" }),
      { status: 500 }
    );
  }

  const records = [];
  let offset = "";

  try {
    do {
      const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableName}`);
      url.searchParams.set("pageSize", "100");
      if (offset) url.searchParams.set("offset", offset);

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return new Response(JSON.stringify({ error: errorText }), { status: 500 });
      }

      const data = await response.json();
      records.push(...(data.records || []));
      offset = data.offset || "";
    } while (offset);

    return new Response(JSON.stringify({ records }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};
