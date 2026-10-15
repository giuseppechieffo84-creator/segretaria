// Segretaria — Worker Cloudflare per promemoria Web Push e calendario Google in sola lettura.
//
// Segreti (mai nel repo): VAPID_PRIVATE_JWK (wrangler secret put).
// Dati in KV (binding SEGRETARIA):
//   auth  -> hash SHA-256 del token dell'app (abbinamento al primo collegamento)
//   sub   -> sottoscrizione push del telefono
//   rem   -> { list: [{id, at, title, body}], sent: {chiave: at} }
//   ics   -> indirizzo segreto iCal di Google Calendar
// Per ricollegare il telefono da capo: wrangler kv key delete --binding SEGRETARIA auth --remote

import { b64u, sha256hex, sendPush } from './push.js';
import { expandCalendar } from './ics.js';

// ---------- promemoria ----------
async function runReminders(env) {
  const [sub, rem] = await Promise.all([env.SEGRETARIA.get('sub', 'json'), env.SEGRETARIA.get('rem', 'json')]);
  if (!sub || !rem?.list?.length) return { sent: 0 };
  const now = Date.now();
  const sent = rem.sent || {};
  let n = 0, changed = false;
  for (const r of rem.list) {
    const k = `${r.id}@${r.at}`;
    // finestra di 15 minuti: se un giro del cron salta, il promemoria parte comunque
    if (r.at > now || r.at < now - 15 * 60000 || sent[k]) continue;
    const status = await sendPush(env, sub, { title: r.title, body: r.body || '', tag: r.id });
    sent[k] = r.at; changed = true;
    if (status === 404 || status === 410) { await env.SEGRETARIA.delete('sub'); break; }
    if (status < 300) n++;
  }
  for (const k of Object.keys(sent)) if (sent[k] < now - 2 * 86400000) { delete sent[k]; changed = true; }
  if (changed) await env.SEGRETARIA.put('rem', JSON.stringify({ list: rem.list, sent }));
  return { sent: n };
}

// ---------- HTTP ----------
function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
async function authorized(env, req) {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const stored = await env.SEGRETARIA.get('auth');
  return !!(tok && stored && (await sha256hex(tok)) === stored);
}

// solo https; DEV_ALLOW_HTTP=1 esiste solo nel collaudo locale (wrangler dev)
const okUrl = (env, u) => typeof u === 'string' && /^\S+$/.test(u) && (u.startsWith('https://') || (env.DEV_ALLOW_HTTP === '1' && u.startsWith('http://')));

async function handle(req, env) {
  const url = new URL(req.url);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors(env, req) } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, req) });
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /health') return json({ ok: true, paired: !!(await env.SEGRETARIA.get('auth')) });
  if (route === 'GET /vapid') return json({ publicKey: env.VAPID_PUBLIC });
  if (route === 'POST /pair') {
    // primo collegamento: chi arriva per primo riceve il token (poi l'abbinamento si chiude)
    if (await env.SEGRETARIA.get('auth')) return json({ error: 'già collegato' }, 409);
    const token = b64u.enc(crypto.getRandomValues(new Uint8Array(32)));
    await env.SEGRETARIA.put('auth', await sha256hex(token));
    return json({ token });
  }
  if (!(await authorized(env, req))) return json({ error: 'non autorizzato' }, 401);

  if (route === 'POST /subscribe') {
    const { subscription } = await req.json();
    if (!okUrl(env, subscription?.endpoint) || !subscription.keys?.p256dh || !subscription.keys?.auth) return json({ error: 'sottoscrizione non valida' }, 400);
    await env.SEGRETARIA.put('sub', JSON.stringify(subscription));
    return json({ ok: true });
  }
  if (route === 'POST /sync') {
    const { reminders } = await req.json();
    if (!Array.isArray(reminders)) return json({ error: 'reminders mancante' }, 400);
    const list = reminders.slice(0, 500).map((r) => ({ id: String(r.id).slice(0, 80), at: +r.at, title: String(r.title || '').slice(0, 120), body: String(r.body || '').slice(0, 200) })).filter((r) => r.at > 0);
    const old = (await env.SEGRETARIA.get('rem', 'json')) || {};
    await env.SEGRETARIA.put('rem', JSON.stringify({ list, sent: old.sent || {} }));
    return json({ ok: true, count: list.length });
  }
  if (route === 'POST /test') {
    const sub = await env.SEGRETARIA.get('sub', 'json');
    if (!sub) return json({ error: 'nessun telefono registrato' }, 404);
    const status = await sendPush(env, sub, { title: 'Segretaria', body: 'Notifica di prova: i promemoria funzionano.', tag: 'test' });
    return json({ ok: status < 300, status });
  }
  if (route === 'POST /calendar-url') {
    const { url: ics } = await req.json();
    if (!okUrl(env, ics)) return json({ error: 'indirizzo non valido' }, 400);
    await env.SEGRETARIA.put('ics', ics);
    return json({ ok: true });
  }
  if (route === 'DELETE /calendar-url') { await env.SEGRETARIA.delete('ics'); return json({ ok: true }); }
  if (route === 'GET /calendar') {
    const ics = await env.SEGRETARIA.get('ics');
    if (!ics) return json({ configured: false, events: [] });
    const tz = url.searchParams.get('tz') || 'Europe/Rome';
    const days = Math.min(+url.searchParams.get('days') || 60, 180);
    const res = await fetch(ics, { cf: { cacheTtl: 300 } });
    if (!res.ok) return json({ configured: true, error: `calendario non raggiungibile (${res.status})`, events: [] }, 502);
    const now = Date.now();
    return json({ configured: true, events: expandCalendar(await res.text(), tz, now - 86400000, now + days * 86400000) });
  }
  return json({ error: 'non trovato' }, 404);
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (err) { return new Response(JSON.stringify({ error: 'errore interno' }), { status: 500, headers: { 'Content-Type': 'application/json', ...cors(env, req) } }); }
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(runReminders(env)); },
};
