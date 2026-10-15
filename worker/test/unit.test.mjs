// node worker/test/unit.test.mjs — verifica cifratura Web Push, firma VAPID e lettura iCal
import { webcrypto as wc, createECDH, createHmac, createDecipheriv, createPublicKey, verify } from 'node:crypto';
import { encryptPayload, sendPush, b64u } from '../src/push.js';
import { expandCalendar } from '../src/ics.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();

// ---- Web Push: il "telefono" decifra il messaggio (RFC 8291) ----
const ua = createECDH('prime256v1'); ua.generateKeys();
const authSecret = wc.getRandomValues(new Uint8Array(16));
const sub = { endpoint: 'https://push.example.test/abc', keys: { p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(authSecret) } };
function decrypt(body) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16); const rs = buf.readUInt32BE(16); const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen); const ct = buf.subarray(21 + idlen);
  const ecdh = ua.computeSecret(asPublic);
  const prkKey = hmac(authSecret, ecdh);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return { rs, text: pt.subarray(0, pt.lastIndexOf(2)).toString() };
}
const body = await encryptPayload(sub, JSON.stringify({ title: 'Dentista', body: 'Alle 17:30' }));
const dec = decrypt(body);
ok(dec.rs === 4096 && JSON.parse(dec.text).title === 'Dentista', 'messaggio push decifrabile dal telefono');

// ---- VAPID: firma verificabile con la chiave pubblica ----
const vk = await wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const env = {
  VAPID_PRIVATE_JWK: JSON.stringify(await wc.subtle.exportKey('jwk', vk.privateKey)),
  VAPID_PUBLIC: b64u.enc(await wc.subtle.exportKey('raw', vk.publicKey)),
  VAPID_SUBJECT: 'https://example.test/',
};
let captured;
globalThis.fetch = async (url, init) => { captured = { url, init }; return new Response(null, { status: 201 }); };
const status = await sendPush(env, sub, { title: 'x' });
const h = captured.init.headers;
const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h.Authorization);
const [hd, pl, sig] = jwt.split('.');
const claims = JSON.parse(Buffer.from(b64u.dec(pl)).toString());
const pub = createPublicKey({ key: await wc.subtle.exportKey('jwk', vk.publicKey), format: 'jwk' });
const valid = verify('sha256', Buffer.from(`${hd}.${pl}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64u.dec(sig)));
ok(status === 201 && valid && k === env.VAPID_PUBLIC, 'firma VAPID valida');
ok(claims.aud === 'https://push.example.test' && claims.exp > Date.now() / 1000 && claims.sub === env.VAPID_SUBJECT, 'claim VAPID corretti');
ok(h['Content-Encoding'] === 'aes128gcm' && h.TTL && decrypt(captured.init.body).text === '{"title":"x"}', 'header e corpo della richiesta push');

// ---- iCal ----
const ics = `BEGIN:VCALENDAR
X-WR-TIMEZONE:Europe/Rome
BEGIN:VEVENT
UID:single@x
DTSTART:20261016T080000Z
DTEND:20261016T090000Z
SUMMARY:Riunione\\, con virgola
LOCATION:Ufficio
END:VEVENT
BEGIN:VEVENT
UID:weekly@x
DTSTART;TZID=Europe/Rome:20261019T090000
DTEND;TZID=Europe/Rome:20261019T093000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261105T000000Z
EXDATE;TZID=Europe/Rome:20261021T090000
SUMMARY:Palestra
END:VEVENT
BEGIN:VEVENT
UID:weekly@x
RECURRENCE-ID;TZID=Europe/Rome:20261026T090000
DTSTART;TZID=Europe/Rome:20261026T110000
DTEND;TZID=Europe/Rome:20261026T113000
SUMMARY:Palestra (spostata)
END:VEVENT
BEGIN:VEVENT
UID:allday@x
DTSTART;VALUE=DATE:20261020
DTEND;VALUE=DATE:20261021
SUMMARY:Compleanno
RRULE:FREQ=YEARLY
END:VEVENT
BEGIN:VEVENT
UID:monthly@x
DTSTART;TZID=Europe/Rome:20261030T180000
DURATION:PT1H
RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3
SUMMARY:Aperitivo
END:VEVENT
BEGIN:VEVENT
UID:cancel@x
DTSTART:20261017T080000Z
STATUS:CANCELLED
SUMMARY:Annullato
END:VEVENT
END:VCALENDAR`.replace(/\n/g, '\r\n');
const from = Date.UTC(2026, 9, 15), to = Date.UTC(2027, 0, 31);
const ev = expandCalendar(ics, 'Europe/Rome', from, to);
const f = (t) => ev.filter((e) => e.title === t).map((e) => `${e.date} ${e.time}-${e.end}`);
ok(JSON.stringify(f('Riunione, con virgola')) === '["2026-10-16 10:00-11:00"]', 'evento UTC convertito in ora italiana ' + f('Riunione, con virgola'));
ok(JSON.stringify(f('Palestra')) === JSON.stringify(['2026-10-19 09:00-09:30', '2026-10-28 09:00-09:30', '2026-11-02 09:00-09:30', '2026-11-04 09:00-09:30']),
  'settimanale: BYDAY, EXDATE, eccezione spostata, cambio ora legale, UNTIL ' + f('Palestra'));
ok(JSON.stringify(f('Palestra (spostata)')) === '["2026-10-26 11:00-11:30"]', 'occorrenza spostata');
ok(ev.some((e) => e.title === 'Compleanno' && e.date === '2026-10-20' && e.allDay && !e.time), 'evento di tutto il giorno');
ok(JSON.stringify(f('Aperitivo')) === JSON.stringify(['2026-10-30 18:00-19:00', '2026-11-27 18:00-19:00', '2026-12-25 18:00-19:00']), 'mensile ultimo venerdì con COUNT ' + f('Aperitivo'));
ok(!ev.some((e) => e.title === 'Annullato'), 'evento annullato escluso');
ok(new Set(ev.map((e) => e.id)).size === ev.length, 'id univoci');

console.log(fails ? `\n${fails} FALLITI` : '\nTUTTO OK');
process.exit(fails ? 1 : 0);
