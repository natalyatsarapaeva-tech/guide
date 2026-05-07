# Task Intake Worker — Setup Guide

Cloudflare Worker that receives emails (via Postmark) and Slack messages,
parses them with GPT-4o, and writes tasks directly to your Firebase.

---

## What you get

| Source | How it works |
|--------|-------------|
| **Email** | Forward any email to your Postmark address → task created automatically |
| **Slack** | Type `/task Buy flowers for Mum by Friday` → task created in app |
| **Test** | POST to `/test` endpoint to verify setup |

---

## Step 1 — Deploy the Worker to Cloudflare

### Install Wrangler (Cloudflare CLI)
```bash
npm install -g wrangler
wrangler login   # opens browser, log in with your Cloudflare account
```

### Deploy
```bash
cd worker/
wrangler deploy
```

After deploy you'll get a URL like:
`https://task-intake-worker.YOUR-SUBDOMAIN.workers.dev`

Save this URL — you'll need it for Postmark and Slack.

---

## Step 2 — Add secrets in Cloudflare dashboard

Go to: **Cloudflare Dashboard → Workers → task-intake-worker → Settings → Variables**

Add these as **Encrypted** environment variables (not plain text):

| Variable | Value |
|----------|-------|
| `OPENAI_API_KEY` | Your OpenAI key: `sk-...` |
| `FIREBASE_PROJECT_ID` | `natas-kitchen` |
| `FIREBASE_CLIENT_EMAIL` | `firebase-adminsdk-fbsvc@natas-kitchen.iam.gserviceaccount.com` |
| `FIREBASE_PRIVATE_KEY` | The full private key from your service account JSON, including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` |
| `ALLOWED_SENDERS` | Your email address(es), comma-separated: `you@gmail.com,other@gmail.com` |

> ⚠️ **Never** put these values in any file or commit them to GitHub.
> Cloudflare encrypts them and they're never visible again after saving.

---

## Step 3 — Test the Worker

```bash
curl -X POST https://task-intake-worker.YOUR-SUBDOMAIN.workers.dev/test \
  -H "Content-Type: application/json" \
  -d '{"text": "Schedule dentist appointment for next Tuesday"}'
```

Expected response:
```json
{"status": "ok", "task": {"title": "Schedule dentist appointment", ...}}
```

Open your app and check if the task appeared.

---

## Step 4 — Set up Postmark (inbound email)

1. Create a free account at **postmark.com**
2. Go to **Servers → Default Server → Message Streams → Inbound**
3. Note your inbound email address:
   `abc123@inbound.postmarkapp.com`
4. Set the **Webhook URL** to:
   `https://task-intake-worker.YOUR-SUBDOMAIN.workers.dev/email`
5. Click **Check** to verify it works

### Optional: custom email address

In Postmark → Inbound → Settings → you can set up a custom domain alias
so you can forward to `tasks@yourdomain.com` instead of the postmark address.

### How to use

Forward any email to your Postmark address. GPT will:
- Extract the main task from subject + body
- Auto-assign tags and priority
- Set due date if mentioned
- Put any sub-items as subtasks

---

## Step 5 — Set up Slack

1. Go to **api.slack.com/apps → Create New App → From scratch**
2. Name it "Task Manager" and pick your workspace
3. Go to **Slash Commands → Create New Command**:
   - Command: `/task`
   - Request URL: `https://task-intake-worker.YOUR-SUBDOMAIN.workers.dev/slack`
   - Short description: "Create a task"
   - Usage hint: `[task description] by [date]`
4. Go to **OAuth & Permissions → Scopes → Bot Token Scopes** → add `commands`
5. Install to workspace
6. Optional: add `SLACK_SIGNING_SECRET` to Cloudflare vars for request verification

### How to use

In any Slack channel:
```
/task Review metrics for the new feature launch by next Monday
/task Call client Anya about the proposal — high priority
/task Kids dentist appointment next Thursday
```

---

## Filtering by sender

Set `ALLOWED_SENDERS` in Cloudflare to a comma-separated list of email addresses
that are allowed to create tasks:
```
you@gmail.com,partner@gmail.com
```

Leave empty to allow anyone (not recommended once you go multi-user).

---

## Architecture notes

- The Worker runs on Cloudflare's global edge — no server to manage
- Firebase auth uses a service account JWT signed with Web Crypto API
- Access token is fetched on each request (no caching needed at this scale)
- For higher volume, add a `Cache` for the Firebase token (~1hr TTL)
- Free tier: 100,000 requests/day — enough for personal + small team
- Paid ($5/month): 10M requests — enough for a real product

---

## Upgrading to multi-user (Wave 8)

When you productize, the Worker becomes the central API:
1. Add Firebase Auth token verification in the Worker
2. Route tasks to the correct user's Firestore collection
3. Add a user lookup: `email sender → user ID → correct Firestore path`
4. The Worker already handles all the hard parts (JWT, Firestore REST, GPT)

---

## Troubleshooting

**Task not appearing in app:**
- Check Cloudflare Worker logs: Dashboard → Workers → task-intake-worker → Logs
- Verify `FIREBASE_PRIVATE_KEY` includes the full PEM with newlines (`\n`)
- Check `ALLOWED_SENDERS` isn't blocking your address

**Slack not responding:**
- Slack requires a response within 3 seconds
- Worker is fast enough — if it's slow, check OpenAI API latency
- Check Worker logs for errors

**Postmark not sending:**
- Verify the webhook URL is correct (no trailing slash)
- Check Postmark Activity log for bounce/errors
