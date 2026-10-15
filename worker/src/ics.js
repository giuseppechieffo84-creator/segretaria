import { enc, b64u } from './push.js';

// ---------- calendario (iCal) ----------
function tzParts(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function zonedToUtc(y, m, d, h, mi, s, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const p = tzParts(ts, tz);
    const seen = Date.UTC(+p.date.slice(0, 4), +p.date.slice(5, 7) - 1, +p.date.slice(8, 10), +p.time.slice(0, 2), +p.time.slice(3, 5), s);
    ts = guess - (seen - ts);
  }
  return ts;
}
// valore DTSTART/DTEND/EXDATE/UNTIL -> { allDay, y, m, d, h, mi, s, tz } (tz null = UTC)
function parseDT(value, params, defTz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { allDay: true, y: +y, m: +mo, d: +d, h: 0, mi: 0, s: 0, tz: defTz };
  return { allDay: false, y: +y, m: +mo, d: +d, h: +h, mi: +mi, s: +s, tz: z ? null : (params.TZID || defTz) };
}
const toUtc = (dt) => (dt.tz ? zonedToUtc(dt.y, dt.m, dt.d, dt.h, dt.mi, dt.s, dt.tz) : Date.UTC(dt.y, dt.m - 1, dt.d, dt.h, dt.mi, dt.s));
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
const fromDayNum = (n) => { const x = new Date(n * 86400000); return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()]; };
const WD = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };
const icsText = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseICS(text, defTz) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = []; let cur = null; let calTz = defTz;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    const i = line.indexOf(':'); if (i < 0) continue;
    const [name, ...ps] = line.slice(0, i).split(';');
    const value = line.slice(i + 1);
    const params = Object.fromEntries(ps.map((p) => p.split('=')));
    if (!cur) { if (name === 'X-WR-TIMEZONE') calTz = value.trim(); continue; }
    if (name === 'SUMMARY') cur.title = icsText(value);
    else if (name === 'LOCATION') cur.location = icsText(value);
    else if (name === 'UID') cur.uid = value;
    else if (name === 'STATUS') cur.status = value;
    else if (name === 'RRULE') cur.rrule = Object.fromEntries(value.split(';').map((p) => p.split('=')));
    else if (name === 'DTSTART') cur.start = { value, params };
    else if (name === 'DTEND') cur.end = { value, params };
    else if (name === 'DURATION') cur.duration = value;
    else if (name === 'EXDATE') value.split(',').forEach((v) => cur.exdates.push({ value: v, params }));
    else if (name === 'RECURRENCE-ID') cur.recurrenceId = { value, params };
  }
  return { events, calTz };
}
function durationMs(v) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v || '');
  if (!m) return 0;
  const [, w, d, h, mi, s] = m.map((x) => +x || 0);
  return ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}
// genera le date (y,m,d) delle occorrenze secondo la RRULE, limitate a `toDay`
function* occurrences(start, rule, toDay) {
  const freq = rule.FREQ; const interval = +(rule.INTERVAL || 1);
  const s0 = dayNum(start.y, start.m, start.d);
  if (freq === 'DAILY') { for (let n = s0; n <= toDay; n += interval) yield fromDayNum(n); return; }
  if (freq === 'WEEKLY') {
    const days = rule.BYDAY ? rule.BYDAY.split(',').map((x) => WD[x.slice(-2)]) : [new Date(s0 * 86400000).getUTCDay()];
    const monday = s0 - ((new Date(s0 * 86400000).getUTCDay() + 6) % 7);
    for (let w = monday; w <= toDay; w += 7 * interval) {
      for (const dow of [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) {
        const n = w + ((dow + 6) % 7);
        if (n >= s0 && n <= toDay) yield fromDayNum(n);
      }
    }
    return;
  }
  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const stepMonths = freq === 'MONTHLY' ? interval : 12 * interval;
    for (let k = 0; k < 2000; k += stepMonths) {
      const y = start.y + Math.floor((start.m - 1 + k) / 12); const m = ((start.m - 1 + k) % 12) + 1;
      if (dayNum(y, m, 1) > toDay) return;
      let d = start.d;
      const by = freq === 'MONTHLY' && rule.BYDAY && /^(-?\d)(\w\w)$/.exec(rule.BYDAY);
      if (by) {
        const ord = +by[1]; const dow = WD[by[2]];
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const cands = []; for (let x = 1; x <= last; x++) if (new Date(Date.UTC(y, m - 1, x)).getUTCDay() === dow) cands.push(x);
        d = ord > 0 ? cands[ord - 1] : cands[cands.length + ord];
      } else if (rule.BYMONTHDAY) d = +rule.BYMONTHDAY;
      if (!d || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) continue;
      const n = dayNum(y, m, d);
      if (n >= s0 && n <= toDay) yield [y, m, d];
    }
  }
}
export function expandCalendar(text, tz, fromTs, toTs) {
  const { events, calTz } = parseICS(text, tz);
  const out = [];
  const overrides = new Set(events.filter((e) => e.recurrenceId).map((e) => `${e.uid}|${toUtc(parseDT(e.recurrenceId.value, e.recurrenceId.params, calTz))}`));
  const toDay = Math.floor(toTs / 86400000) + 1;
  for (const e of events) {
    if (!e.start || e.status === 'CANCELLED') continue;
    const st = parseDT(e.start.value, e.start.params, calTz); if (!st) continue;
    const en = e.end && parseDT(e.end.value, e.end.params, calTz);
    const dur = en ? toUtc(en) - toUtc(st) : durationMs(e.duration);
    const emit = (ts) => {
      if (ts + Math.max(dur, 0) < fromTs || ts > toTs) return;
      const s = st.allDay ? { date: new Date(ts).toISOString().slice(0, 10), time: '' } : tzParts(ts, tz);
      const end = !st.allDay && dur > 0 ? tzParts(ts + dur, tz).time : '';
      out.push({ id: `g-${b64u.enc(enc.encode(`${e.uid}|${ts}`)).slice(-24)}`, title: e.title || '(senza titolo)', date: s.date, time: s.time, end, location: e.location || '', allDay: st.allDay });
    };
    const startTs = st.allDay ? Date.UTC(st.y, st.m - 1, st.d) : toUtc(st);
    if (!e.rrule || e.recurrenceId) { emit(startTs); continue; }
    const ex = new Set(e.exdates.map((x) => { const p = parseDT(x.value, x.params, calTz); return p && (st.allDay ? Date.UTC(p.y, p.m - 1, p.d) : toUtc(p)); }));
    const until = e.rrule.UNTIL ? parseDT(e.rrule.UNTIL, {}, null) : null;
    const untilTs = until ? (until.allDay ? Date.UTC(until.y, until.m - 1, until.d, 23, 59, 59) : toUtc(until)) : Infinity;
    let count = 0; const max = e.rrule.COUNT ? +e.rrule.COUNT : Infinity;
    for (const [y, m, d] of occurrences(st, e.rrule, toDay)) {
      const ts = st.allDay ? Date.UTC(y, m - 1, d) : toUtc({ ...st, y, m, d });
      if (ts > untilTs || count >= max) break;
      count++;
      if (ex.has(ts) || overrides.has(`${e.uid}|${ts}`)) continue;
      emit(ts);
    }
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

