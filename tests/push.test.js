// Collaudo locale app + Worker: node tests/push.test.js <URL app con / finale>
// Richiede: playwright e wrangler installati (NODE_PATH), l'app servita su localhost.
// Avvia wrangler dev su una copia del Worker con chiavi VAPID di prova e un finto servizio push
// che decifra i messaggi come farebbe il telefono.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { webcrypto: wc, createECDH, createHmac, createDecipheriv } = require('crypto');

const APP = process.argv[2];
const APP_ORIGIN = new URL(APP).origin;
const WPORT = 8787, MPORT = 8790;
const WORKER = `http://127.0.0.1:${WPORT}`;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };
const b64u = (b) => Buffer.from(b).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();

// --- finto telefono: chiavi della sottoscrizione ---
const ua = createECDH('prime256v1'); ua.generateKeys();
const authSecret = Buffer.from(wc.getRandomValues(new Uint8Array(16)));
function decrypt(buf) {
  const salt = buf.subarray(0, 16); const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen); const ct = buf.subarray(21 + idlen);
  const ikm = hmac(hmac(authSecret, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(pt.subarray(0, pt.lastIndexOf(2)).toString());
}

// --- finto servizio push + file iCal ---
const pushes = [];
const tomorrow = new Date(Date.now() + 86400000);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const ICS = ['BEGIN:VCALENDAR', 'X-WR-TIMEZONE:Europe/Rome', 'BEGIN:VEVENT', 'UID:t1@x',
  `DTSTART;TZID=Europe/Rome:${ymd(tomorrow)}T100000`, `DTEND;TZID=Europe/Rome:${ymd(tomorrow)}T110000`,
  'SUMMARY:Visita da Google', 'LOCATION:Studio', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url === '/cal.ics') { res.writeHead(200, { 'Content-Type': 'text/calendar' }); return res.end(ICS); }
    pushes.push({ headers: req.headers, data: decrypt(Buffer.concat(chunks)) });
    res.writeHead(201); res.end();
  });
}).listen(MPORT);

(async () => {
  // --- Worker locale con chiavi di prova (copia fuori dal repo) ---
  const vk = await wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'segretaria-worker-'));
  fs.cpSync(path.join(__dirname, '..', 'worker'), tmp, { recursive: true });
  const pub = b64u(await wc.subtle.exportKey('raw', vk.publicKey));
  fs.writeFileSync(path.join(tmp, '.dev.vars'), [
    `VAPID_PRIVATE_JWK='${JSON.stringify(await wc.subtle.exportKey('jwk', vk.privateKey))}'`,
    `VAPID_PUBLIC=${pub}`, `ALLOWED_ORIGINS=${APP_ORIGIN}`, 'DEV_ALLOW_HTTP=1',
  ].join('\n'));
  // WRANGLER = percorso di wrangler/bin/wrangler.js: avviato con node, senza shell, così si chiude davvero
  const wr = spawn(process.execPath, [process.env.WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(WPORT), '--test-scheduled'], { cwd: tmp });
  let wlog = ''; wr.stdout.on('data', (d) => (wlog += d)); wr.stderr.on('data', (d) => (wlog += d));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(WORKER + '/health')).ok) break; } catch {} await sleep(1000); }
  const cron = () => fetch(`${WORKER}/__scheduled?cron=*+*+*+*+*`);

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 839 } });
    await ctx.grantPermissions(['notifications'], { origin: APP_ORIGIN });
    // il Chromium di test non ha un servizio push: la sottoscrizione punta al finto servizio
    const fakeSub = { endpoint: `http://127.0.0.1:${MPORT}/push/telefono`, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) } };
    await ctx.addInitScript(([sub, key]) => {
      const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (key.length % 4)) % 4)), (c) => c.charCodeAt(0)).buffer;
      let current = null;
      const make = () => ({ endpoint: sub.endpoint, options: { applicationServerKey: raw }, toJSON: () => sub, unsubscribe: async () => { current = null; return true; } });
      PushManager.prototype.getSubscription = async () => current;
      PushManager.prototype.subscribe = async () => (current = make());
    }, [fakeSub, pub]);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(APP, { waitUntil: 'networkidle' });
    await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });

    // collegamento
    await page.click('#btnSettings');
    await page.fill('#workerUrl', WORKER);
    await page.click('#btnPair');
    await page.waitForFunction(() => /Collegato|non riuscito|negato|supporta|già/.test(document.querySelector('#pushStatus').textContent), null, { timeout: 15000 })
      .catch(async () => console.log('stato:', await page.textContent('#pushStatus'), wlog.slice(-1500)));
    ok((await page.textContent('#pushStatus')).startsWith('Collegato'), 'telefono collegato: ' + (await page.textContent('#pushStatus')));
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('segretaria.settings')).workerToken);
    ok(token && token.length > 30, 'token salvato solo nelle impostazioni locali');

    await page.click('#btnTestPush');
    await page.waitForFunction(() => /inviata|risposto|riuscita/.test(document.querySelector('#pushStatus').textContent));
    ok(pushes.at(-1)?.data?.body?.includes('prova') && pushes.at(-1).headers.authorization.startsWith('vapid t='), 'notifica di prova arrivata e decifrata');

    // calendario Google
    await page.fill('#icsUrl', `http://127.0.0.1:${MPORT}/cal.ics`);
    await page.click('#btnIcs');
    await page.waitForFunction(() => /Calendario/.test(document.querySelector('#pushStatus').textContent));
    ok((await page.inputValue('#icsUrl')) === '', 'indirizzo iCal non resta sul telefono');
    await page.click('#dlgSettings button[value=cancel]');
    await page.click('#nav [data-view=agenda]');
    await page.waitForSelector('#eventList:has-text("Visita da Google")');
    const row = page.locator('#eventList .row', { hasText: 'Visita da Google' });
    ok((await row.textContent()).includes('10:00') && (await row.textContent()).includes('Google') && (await row.locator('[data-act=editEvent]').count()) === 0, 'evento Google in agenda, sola lettura');

    // promemoria: attività di oggi all'ora attuale -> arriva al giro del cron
    const now = new Date(); const hhmm = now.toTimeString().slice(0, 5);
    await page.click('#nav [data-view=attivita]');
    await page.fill('#taskForm [name=title]', 'Promemoria di prova');
    await page.fill('#taskForm [name=due]', new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10));
    await page.fill('#taskForm [name=time]', hhmm);
    await page.click('#taskForm button');
    await sleep(3500); // sincronizzazione dopo 2 s
    const before = pushes.length;
    await cron(); await sleep(1500);
    const rem = pushes.slice(before).find((p) => p.data.title === '✅ Promemoria di prova');
    ok(rem && rem.data.body === `Alle ${hhmm}`, 'promemoria inviato dal cron');
    await cron(); await sleep(1500);
    ok(pushes.filter((p) => p.data.title === '✅ Promemoria di prova').length === 1, 'nessun doppione al giro successivo');

    // sicurezza
    const r1 = await fetch(WORKER + '/sync', { method: 'POST', body: '{"reminders":[]}' });
    const r2 = await fetch(WORKER + '/calendar', { headers: { Authorization: 'Bearer sbagliato' } });
    ok(r1.status === 401 && r2.status === 401, 'senza token il server rifiuta');
    const r3 = await fetch(WORKER + '/pair', { method: 'POST' });
    ok(r3.status === 409, 'secondo abbinamento rifiutato');
    const r4 = await fetch(WORKER + '/health', { headers: { Origin: 'https://sito-estraneo.example' } });
    ok(r4.headers.get('access-control-allow-origin') !== 'https://sito-estraneo.example', 'CORS solo per l\'app');

    ok(errors.length === 0, 'nessun errore nella pagina ' + JSON.stringify(errors));
    await page.screenshot({ path: path.join(os.tmpdir(), 'segretaria-agenda.png') });
  } catch (err) { ok(false, 'eccezione: ' + err.message.split(String.fromCharCode(10))[0]); } finally {
    await browser.close(); mock.close();
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(wr.pid), '/T', '/F']); else wr.kill();
    if (fails) console.log(wlog.slice(-2000));
    console.log(fails ? `\n${fails} FALLITI` : '\nTUTTO OK');
    setTimeout(() => process.exit(fails ? 1 : 0), 500);
  }
})();
