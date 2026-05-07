/**
 * task-intake-worker.js
 * Cloudflare Worker — inbound task intake
 *
 * Handles:
 *   POST /email   ← Postmark inbound webhook
 *   POST /slack   ← Slack Events API (DM messages) + slash commands
 *   POST /test    ← manual testing
 *
 * Environment variables (Cloudflare dashboard → Worker → Settings → Variables):
 *   OPENAI_API_KEY          — your OpenAI key (sk-...)
 *   FIREBASE_PROJECT_ID     — "natas-kitchen"
 *   FIREBASE_CLIENT_EMAIL   — service account email
 *   FIREBASE_PRIVATE_KEY    — service account private key (full PEM string)
 *   SLACK_BOT_TOKEN         — Bot User OAuth Token (xoxb-...)
 *   SLACK_SIGNING_SECRET    — for verifying Slack requests (optional but recommended)
 *   POSTMARK_WEBHOOK_TOKEN  — for verifying Postmark requests (optional)
 *   ALLOWED_SENDERS         — comma-separated allowed email addresses
 */

// ─── ROUTING ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }

    try {
      switch (url.pathname) {
        case '/email':   return await handleEmail(request, env, ctx);
        case '/slack':   return await handleSlack(request, env, ctx);
        case '/test':    return await handleTest(request, env);
        case '/narrate': return await handleNarrate(request, env);
        default:         return json({ error: 'Unknown endpoint' }, 404);
      }
    } catch (e) {
      console.error('Worker error:', e);
      return json({ error: e.message }, 500);
    }
  }
};

// ─── EMAIL HANDLER ──────────────────────────────────────────────────────────

async function handleEmail(request, env, ctx) {
  if (env.POSTMARK_WEBHOOK_TOKEN) {
    const token = request.headers.get('X-Postmark-Signature') || '';
    if (token !== env.POSTMARK_WEBHOOK_TOKEN) {
      return json({ error: 'Invalid webhook token' }, 401);
    }
  }

  const body = await request.json();

  const sender = (body.From || body.from || '').toLowerCase().replace(/.*<(.+)>/, '$1').trim();
  if (env.ALLOWED_SENDERS) {
    const allowed = env.ALLOWED_SENDERS.split(',').map(s => s.trim().toLowerCase());
    if (allowed.length && !allowed.includes(sender)) {
      console.log(`Rejected sender: ${sender}`);
      return json({ status: 'sender not allowed' }, 200);
    }
  }

  const subject  = body.Subject || body.subject || '';
  const textBody = body.TextBody || body.text || '';
  const htmlBody = body.HtmlBody || body.html || '';
  const rawText  = textBody || htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  if (!rawText && !subject) return json({ status: 'empty email, skipped' }, 200);

  const fullContent = subject ? `Subject: ${subject}\n\n${rawText}` : rawText;

  // Determine email type by sender domain
  const senderDomain = sender.split('@')[1] || '';
  const isWorkEmail = senderDomain === 'vchain.se';
  const isPersonalEmail = ['gmail.com','yandex.ru'].includes(senderDomain);
  const emailType = isWorkEmail ? 'email_work' : isPersonalEmail ? 'email_personal' : 'email';

  // Fire-and-forget so Postmark gets 200 immediately
  ctx.waitUntil((async () => {
    const task = await parseToTask(fullContent, emailType, env);
    await saveTask(task, env);
  })());

  return json({ status: 'ok' }, 200);
}

// ─── SLACK HANDLER ──────────────────────────────────────────────────────────

async function handleSlack(request, env, ctx) {
  const contentType = request.headers.get('content-type') || '';
  let body;

  // Clone request for body reading (can only read once)
  const rawBody = await request.text();

  if (contentType.includes('application/json')) {
    body = JSON.parse(rawBody);
  } else {
    // Slash command — form-encoded
    body = Object.fromEntries(new URLSearchParams(rawBody));
  }

  // ── Slack URL verification challenge (one-time setup) ──
  if (body.type === 'url_verification') {
    return new Response(body.challenge, {
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // ── DM message event ──
  if (body.type === 'event_callback' && body.event) {
    const event = body.event;

    // Only handle direct messages, ignore bot's own messages
    if (event.type === 'message' && event.channel_type === 'im' && !event.bot_id && !event.subtype) {
      const text = event.text || '';
      const userId = event.user || '';

      if (!text.trim()) return json({ ok: true }, 200);

      // Respond immediately to Slack (required within 3s)
      // Then process in background
      ctx.waitUntil((async () => {
        try {
          const task = await parseToTask(text, 'slack', env);
          await saveTask(task, env);

          // Send confirmation back to user via Slack API
          if (env.SLACK_BOT_TOKEN && event.channel) {
            const msg = `✅ *Task created:* ${task.title}` +
              (task.dueDate ? `\n📅 Due: ${task.dueDate}` : '') +
              (task.priority && task.priority !== 'none' ? `\n🔴 Priority: ${task.priority}` : '') +
              (task.tags?.length ? `\n🏷 Tags: ${task.tags.join(', ')}` : '');

            await fetch('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`
              },
              body: JSON.stringify({
                channel: event.channel,
                text: msg
              })
            });
          }
        } catch (e) {
          console.error('Slack DM processing error:', e);
          // Try to notify user of error
          if (env.SLACK_BOT_TOKEN && event.channel) {
            await fetch('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`
              },
              body: JSON.stringify({
                channel: event.channel,
                text: `❌ Sorry, couldn't create the task: ${e.message}`
              })
            });
          }
        }
      })());

      return json({ ok: true }, 200);
    }

    return json({ ok: true }, 200);
  }

  // ── Slash command (/task) ──
  if (body.command) {
    const text = body.text || '';
    const userName = body.user_name || 'user';

    if (!text.trim()) {
      return json({
        response_type: 'ephemeral',
        text: '⚠️ Please add a task description. Example: `/task Call client by Friday`'
      });
    }

    // Respond immediately, process in background
    ctx.waitUntil((async () => {
      const task = await parseToTask(`From ${userName}: ${text}`, 'slack', env);
      await saveTask(task, env);

      // Send delayed response
      if (body.response_url) {
        await fetch(body.response_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'ephemeral',
            text: `✅ *Task created:* ${task.title}` +
              (task.dueDate ? ` · due ${task.dueDate}` : '') +
              (task.tags?.length ? ` · tags: ${task.tags.join(', ')}` : '')
          })
        });
      }
    })());

    // Immediate ack to Slack (within 3s requirement)
    return json({
      response_type: 'ephemeral',
      text: '⏳ Creating task...'
    }, 200);
  }

  return json({ ok: true }, 200);
}

// ─── TEST HANDLER ───────────────────────────────────────────────────────────

async function handleTest(request, env) {
  const body = await request.json().catch(() => ({}));
  const text = body.text || 'Test task — schedule dentist appointment next week';
  const source = body.source || 'test';

  const task = await parseToTask(text, source, env);
  await saveTask(task, env);

  return json({ status: 'ok', task }, 200);
}

// ─── GPT PARSER ─────────────────────────────────────────────────────────────

async function parseToTask(rawText, source, env) {
  const today = new Date().toISOString().split('T')[0];
  const todayDate = new Date();
  const dayName = todayDate.toLocaleDateString('en-US', { weekday: 'long' });
  const monthName = todayDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const sourceInstructions = {
    email: `This text is an EMAIL received by Natalya (the user).
Your job:
1. Identify who sent the email and what they are asking or requiring from Natalya
2. Extract the TASK that Natalya needs to act on (not what the sender did — what Natalya must DO)
3. Find any deadlines — explicit ("by Friday") or implied ("for our meeting next week")
4. Assess urgency: is this blocking someone? Is there a meeting or event attached?
5. If the email contains multiple action items, make the main one the task and the rest subtasks
6. Identify the sender's name and put it in the notes as: "Task from: [sender name] (email)"
7. "assigned" field: leave EMPTY unless the email explicitly says someone other than Natalya should do this task (e.g. "please ask Masha to handle this")
Task title must start with an action verb (Reply, Send, Review, Prepare, Call, Schedule, etc.)`,

    slack: `This text is a SLACK MESSAGE sent by Natalya to her personal task bot.
Slack is a WORK tool — all tasks from Slack are work-related only.
Use ONLY work tags: dev, strategy, analytics, clients, leads, ux.
Never use personal tags (kids, health, home, travel, rest, swedish, ideas, money, urgent) for Slack messages.
Extract what Natalya wants to remember or act on.
Title must start with an action verb.
If the message mentions it came from someone else (e.g. "from John:"), note that in the task notes as: "Task from: John (Slack)"
"assigned" field: leave EMPTY unless Natalya explicitly says someone else should do this task (e.g. "create task for Masha").`,

    email_work: `This text is a WORK EMAIL received by Natalya from a colleague at vchain.se.
This is definitely a work task — use ONLY work tags: dev, strategy, analytics, clients, leads, ux.
Never use personal tags for work emails.
Your job:
1. Extract the TASK that Natalya needs to act on
2. Find any deadlines — explicit or implied
3. Note the sender in notes as: "Task from: [sender name] (work email)"
4. If multiple action items, make main one the task and rest subtasks
"assigned" field: leave EMPTY unless explicitly stated someone else should do this.
Task title must start with an action verb.`,

    email_personal: `This text is a PERSONAL EMAIL received by Natalya (from gmail.com or yandex.ru).
This could be about kids, health, home, travel, money, or other personal matters.
Use personal tags where appropriate: kids, health, home, travel, rest, money, ideas, swedish.
Use work tags (dev, strategy, etc.) only if the email is clearly work-related despite coming from personal address.
Your job:
1. Extract the TASK that Natalya needs to act on
2. Find any deadlines
3. Note the sender in notes as: "Task from: [sender name] (personal email)"
"assigned" field: leave EMPTY unless explicitly stated.
Task title must start with an action verb.`,

    test: `This is a test input. Extract a task normally. Leave assigned empty.`,
  };

  const systemPrompt = `You are a personal task extraction assistant for Natalya, a Product Director based in Sweden.
Today is ${dayName}, ${today} (${monthName}).

${sourceInstructions[source] || sourceInstructions.test}

Return ONLY valid JSON, no markdown, no explanation:
{
  "title": "Action verb + concise description in English (max 60 chars)",
  "description": "Full original context preserved here",
  "notes": "Task from: [sender name] ([source: email/Slack]) — add only if source is known, otherwise empty string",
  "tags": ["tag1"],
  "dueDate": "YYYY-MM-DD or null",
  "priority": "high|med|low|none",
  "status": "new",
  "assigned": "",
  "subtasks": [
    {"title": "...", "note": "", "dueDate": null, "status": "new", "assigned": ""}
  ]
}

IMPORTANT: "assigned" is WHO WILL EXECUTE the task. Leave it empty string unless explicitly stated.
"notes" is WHERE YOU PUT the sender/source context.

Supported tags: dev, strategy, analytics, clients, leads, ux, kids, health, urgent, ideas, money, home, travel, rest, swedish

Priority rules:
- "high": deadline within 3 days, blocks someone, or text contains urgent/asap/immediately
- "med": deadline within 2 weeks, involves a client or external person waiting
- "low": no deadline, informational, can be done anytime
- "none": unclear

Due date rules:
- Calculate relative dates from today (${today})
- "end of week" = this Friday
- "end of month" = last day of ${monthName}
- "ASAP" = tomorrow
- No date mentioned → null

Always translate to English. Always start title with an action verb.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 600,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: rawText }
      ]
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI error: ${data.error?.message || res.status}`);

  const raw = data.choices[0].message.content.trim()
    .replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/\s*```$/m, '');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = {
      title: rawText.slice(0, 80),
      description: rawText,
      tags: [],
      dueDate: null,
      priority: 'none',
      status: 'new',
      assigned: '',
      subtasks: []
    };
  }

  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    ...parsed,
    source,
    createdAt: new Date().toISOString(),
    notes: parsed.description || '',
    recurring: null,
    primaryTag: parsed.tags?.[0] || null,
  };
}

// ─── FIREBASE WRITER ────────────────────────────────────────────────────────

async function saveTask(task, env) {
  const token = await getFirebaseToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/tasks/${task.id}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ fields: toFirestoreFields(task) })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore write failed: ${err}`);
  }

  return await res.json();
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    fields[key] = toFirestoreValue(value);
  }
  return fields;
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (typeof value === 'object') return { mapValue: { fields: toFirestoreFields(value) } };
  return { stringValue: String(value) };
}

// ─── FIREBASE AUTH ───────────────────────────────────────────────────────────

async function getFirebaseToken(env) {
  const serviceAccountEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKeyPem = env.FIREBASE_PRIVATE_KEY;
  const now = Math.floor(Date.now() / 1000);

  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const payload = btoa(JSON.stringify({
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore'
  })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const signingInput = `${header}.${payload}`;
  const privateKey = await importPrivateKey(privateKeyPem);

  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${signingInput}.${sig}`
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`Firebase token error: ${JSON.stringify(tokenData)}`);
  return tokenData.access_token;
}

async function importPrivateKey(pem) {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '')
    .trim();

  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  return await crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// ─── NARRATE HANDLER (Аудиогид) ────────────────────────────────────────────

async function handleNarrate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { placeDescription, displayName } = body;
  if (!placeDescription || !displayName) {
    return json({ error: 'Missing placeDescription or displayName' }, 400);
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content:
            'Ты — харизматичный русскоязычный экскурсовод. Рассказывай о местах живо, интересно и кратко — как будто идёшь рядом с туристом. Используй 3–5 предложений. Упоминай интересные факты, историю, атмосферу. Никаких заголовков и списков — только живой разговорный текст.',
        },
        {
          role: 'user',
          content: `Я сейчас нахожусь здесь: ${placeDescription}. Полное название: ${displayName}. Расскажи мне об этом месте как экскурсовод.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: err?.error?.message || `OpenAI error ${res.status}` }, 502);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || 'Не удалось получить рассказ.';
  return json({ text });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}
