/**
 * narrate-worker.js — Cloudflare Worker
 *
 * POST /narrate  { placeDescription, displayName }
 *   → { text: "..." }
 *
 * Secrets (Cloudflare dashboard → Worker → Settings → Variables → Secrets):
 *   OPENAI_API_KEY   — sk-...
 *   ALLOWED_ORIGIN   — https://YOUR_USERNAME.github.io  (or * for dev)
 */

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";
    const corsOrigin = allowed === "*" || origin === allowed ? origin || "*" : "";

    const cors = {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/narrate") {
      return Response.json({ error: "Not found" }, { status: 404, headers: cors });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400, headers: cors });
    }

    const { placeDescription, displayName } = body;
    if (!placeDescription || !displayName) {
      return Response.json({ error: "Missing placeDescription or displayName" }, { status: 400, headers: cors });
    }

    if (!env.OPENAI_API_KEY) {
      return Response.json({ error: "Server not configured" }, { status: 500, headers: cors });
    }

    try {
      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 300,
          messages: [
            {
              role: "system",
              content:
                "Ты — харизматичный русскоязычный экскурсовод. Рассказывай о местах живо, интересно и кратко — как будто идёшь рядом с туристом. Используй 3–5 предложений. Упоминай интересные факты, историю, атмосферу. Никаких заголовков и списков — только живой разговорный текст.",
            },
            {
              role: "user",
              content: `Я сейчас нахожусь здесь: ${placeDescription}. Полное название: ${displayName}. Расскажи мне об этом месте как экскурсовод.`,
            },
          ],
        }),
      });

      if (!openaiRes.ok) {
        const err = await openaiRes.json().catch(() => ({}));
        return Response.json(
          { error: err?.error?.message || `OpenAI error ${openaiRes.status}` },
          { status: 502, headers: cors }
        );
      }

      const data = await openaiRes.json();
      const text = data.choices?.[0]?.message?.content || "Не удалось получить рассказ.";
      return Response.json({ text }, { headers: cors });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: cors });
    }
  },
};
