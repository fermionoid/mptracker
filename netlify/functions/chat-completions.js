const UPSTREAM_URL = "https://space.ai-builders.com/backend/v1/chat/completions";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  const apiKey =
    process.env.AI_BUILDERS_API_KEY ||
    process.env.API_KEY ||
    "";

  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        error:
          "Missing server-side API key. Set Netlify environment variable AI_BUILDERS_API_KEY.",
      }),
    };
  }

  try {
    const res = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: event.body || "",
    });

    const text = await res.text().catch(() => "");
    return {
      statusCode: res.status,
      headers: { ...corsHeaders(), "Content-Type": res.headers.get("content-type") || "application/json" },
      body: text,
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ error: e?.message || "Upstream fetch failed" }),
    };
  }
};


