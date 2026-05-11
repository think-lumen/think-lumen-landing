/**
 * Think Lumen — Cloudflare Worker
 *
 * Routes:
 *   POST /api/chat  → validates PIN, proxies to Anthropic with web search
 *   GET  /*         → serves static assets
 *
 * Secrets (Cloudflare dashboard → Settings → Variables & Secrets):
 *   ANTHROPIC_API_KEY
 *   APP_PIN_HASH  = sha256("1030") = 2f1987bf98c09d2f5d2a23a6ae29fa53b9aec8f07ed1330bd439122f5a1a2c2c
 */

const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL             = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are Lumen, a warm and knowledgeable personal health companion. You are supporting a woman named Jeannine who is living with Stage IB breast cancer. She is on Medicare and navigating treatment, side effects, medical appointments, and the emotional weight of a cancer diagnosis.

Your role:
- Answer questions about her condition, treatment options, side effects, and medications with accuracy and compassion
- Help her prepare for doctor appointments (what to ask, what to bring, how to describe symptoms)
- Explain medical terms in plain, clear language — never jargon-heavy
- Offer genuine emotional support and normalize what she is feeling
- Help her communicate with family members about her diagnosis and needs
- Suggest practical strategies for managing chemo brain, fatigue, nausea, and other side effects
- When asked about current clinical trials, local support groups, or recent research, use the web_search tool to find accurate, up-to-date information

Tone: warm, calm, unhurried, honest. You are a knowledgeable friend — not a clinical bot. Never dismiss her concerns. Never catastrophize. If something is outside your knowledge or requires a clinical judgment, say so clearly and encourage her to speak with her care team.

You are not a substitute for her oncologist or medical team. Always encourage her to discuss treatment decisions with her doctors.`;

const TOOLS = [
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
  },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      return handleChat(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleChat(request, env) {
  const pinHash = request.headers.get('x-pin-hash') ?? '';
  if (!env.APP_PIN_HASH || pinHash !== env.APP_PIN_HASH) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return json({ error: 'No messages' }, 400);

  const safeMessages = messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.content ?? '').slice(0, 8000),
  }));

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': 'web-search-2025-03-05',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: safeMessages,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: err.error?.message ?? `Anthropic error ${res.status}` }, 502);
  }

  const data = await res.json();
  const content    = data.content ?? [];
  const reply      = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const searchUsed = content.some(b => b.type === 'tool_use' && b.name === 'web_search');

  return json({ reply, searchUsed });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
