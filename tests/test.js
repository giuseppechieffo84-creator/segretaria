// Uso: node test.js <URL base con / finale>
const { chromium, devices } = require('playwright');
const BASE = process.argv[2];
const readDB = (page) => page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('segretaria'); r.onerror = () => rej(r.error);
  r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('state'); g.onsuccess = () => res(g.result); };
}));
const ready = (page) => page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) fails++; };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // Migrazione da localStorage (versione precedente) in un contesto pulito
  {
    const c2 = await browser.newContext(); const p2 = await c2.newPage();
    await p2.goto(BASE + 'manifest.json');
    await p2.evaluate(() => localStorage.setItem('segretaria.v1', JSON.stringify({ tasks: [{ id: 'old1', title: 'Vecchia attività', due: '', time: '', priority: 'media', done: false }], events: [], notes: [{ id: 'n1', text: 'Nota vecchia', created: '2026-10-01T10:00:00Z' }], habits: [] })));
    await p2.goto(BASE, { waitUntil: 'networkidle' }); await ready(p2);
    const d = await readDB(p2);
    ok(d.tasks[0]?.title === 'Vecchia attività' && d.notes.length === 1, 'migrazione da localStorage a IndexedDB');
    ok(await p2.evaluate(() => !localStorage.getItem('segretaria.v1') && !!localStorage.getItem('segretaria.v1.migrato')), 'copia di riserva della vecchia versione');
    ok((await p2.textContent('#v-oggi')).includes('Vecchia attività'), 'dati migrati visibili');
    await p2.reload({ waitUntil: 'networkidle' }); await ready(p2);
    ok((await p2.textContent('#v-oggi')).includes('Vecchia attività'), 'dati migrati ancora presenti dopo il ricaricamento');
    await c2.close();
  }

  await page.goto(BASE, { waitUntil: 'networkidle' }); await ready(page);
  ok((await page.title()) === 'Segretaria', 'pagina caricata');

  // Manifest
  const href = await page.getAttribute('link[rel=manifest]', 'href');
  const mres = await page.request.get(new URL(href, BASE).href);
  const m = await mres.json();
  ok(mres.ok() && m.name && m.start_url === './' && m.scope === './' && m.display === 'standalone', 'manifest valido (start_url e scope relativi)');
  for (const i of m.icons) {
    const r = await page.request.get(new URL(i.src, new URL(href, BASE)).href);
    ok(r.ok() && r.headers()['content-type'].includes('png'), `icona ${i.src} ${i.sizes} ${i.purpose}`);
  }

  // Service worker
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  ok(scope === BASE, 'service worker attivo, scope ' + scope);

  // Installabilità (criteri Chrome)
  const cdp = await ctx.newCDPSession(page);
  const inst = await cdp.send('Page.getInstallabilityErrors');
  ok(inst.installabilityErrors.length === 0, 'installabile: ' + JSON.stringify(inst.installabilityErrors));
  const man = await cdp.send('Page.getAppManifest');
  ok(!man.errors.length, 'manifest senza errori per Chrome: ' + JSON.stringify(man.errors));

  // Layout: niente scroll orizzontale
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nessuno scroll orizzontale');

  // Attività, impegno, abitudine
  await page.fill('#quickForm input', 'Comprare il pane');
  await page.press('#quickForm input', 'Enter');
  await page.click('#nav [data-view=agenda]');
  await page.fill('#eventForm [name=title]', 'Dentista');
  await page.fill('#eventForm [name=time]', '17:30');
  await page.click('#eventForm button');
  await page.click('#nav [data-view=abitudini]');
  await page.fill('#habitForm [name=title]', 'Camminare');
  await page.click('#habitForm button');
  await page.click('#habitList [data-act=toggleHabit]');
  await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  const txt = await page.textContent('#v-oggi');
  ok(txt.includes('Comprare il pane'), 'attività presente dopo il ricaricamento');
  ok(txt.includes('Dentista') && txt.includes('17:30'), 'impegno di oggi presente dopo il ricaricamento');
  ok(txt.includes('Camminare') && txt.includes('Serie: 1 giorno'), 'abitudine e serie presenti dopo il ricaricamento ' + JSON.stringify((await readDB(page)).habits));

  // Assistente con API simulata
  await page.evaluate(() => localStorage.setItem('segretaria.settings', JSON.stringify({ apiKey: 'sk-ant-test-finta', model: 'claude-haiku-5-5' })));
  await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  const calls = [];
  await page.route('https://api.anthropic.com/v1/messages', async (route) => {
    const req = route.request();
    calls.push({ headers: req.headers(), body: req.postDataJSON() });
    const first = calls.length === 1;
    await route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(first
        ? { id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [
            { type: 'text', text: 'Lo aggiungo.' },
            { type: 'tool_use', id: 'toolu_1', name: 'add_task', input: { title: 'Chiamare il commercialista', due: '2026-10-16', time: '10:00', priority: 'alta' } }] }
        : { id: 'msg_2', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fatto: domani alle 10.' }] }),
    });
  });
  await page.click('#nav [data-view=ai]');
  await page.fill('#askForm textarea', 'ricordami di chiamare il commercialista domani alle 10');
  await page.click('#askBtn');
  await page.waitForSelector('.bubble.assistant:has-text("Fatto: domani alle 10.")');
  ok(calls.length === 2, 'due chiamate API (tool_use + risposta finale)');
  const h = calls[0].headers;
  ok(h['x-api-key'] === 'sk-ant-test-finta' && h['anthropic-dangerous-direct-browser-access'] === 'true' && h['anthropic-version'], 'header corretti');
  ok(calls[0].body.model === 'claude-haiku-5-5' && calls[0].body.tools.length === 7, 'modello e 7 strumenti inviati');
  const tr = calls[1].body.messages.at(-1).content[0];
  ok(tr.type === 'tool_result' && tr.tool_use_id === 'toolu_1' && !tr.is_error, 'tool_result rimandato');
  const tasks = (await readDB(page)).tasks;
  ok(tasks.some((t) => t.title === 'Chiamare il commercialista' && t.due === '2026-10-16' && t.priority === 'alta'), 'attività creata dall\'assistente');
  const stored = JSON.stringify(await readDB(page));
  ok(!stored.includes('sk-ant'), 'la chiave non finisce nei dati esportabili');

  // Ricerca, filtri, statistiche
  await page.click('#nav [data-view=oggi]');
  await page.click('#todayTasks .row:has-text("Comprare il pane") [data-act=toggleTask]');
  await page.click('#btnSearch');
  await page.fill('#q', 'commerc');
  const res = await page.innerHTML('#results');
  ok(res.includes('<mark>commerc</mark>ialista') && !res.includes('Dentista'), 'ricerca trova ed evidenzia');
  await page.fill('#q', 'dentista');
  ok((await page.textContent('#results')).includes('Impegni (1)'), 'ricerca negli impegni');
  await page.click('#nav [data-view=attivita]');
  await page.selectOption('#fState', 'done');
  let tl = await page.textContent('#taskList');
  ok(tl.includes('Comprare il pane') && !tl.includes('commercialista'), 'filtro completate');
  await page.selectOption('#fState', 'all'); await page.selectOption('#fPrio', 'alta');
  tl = await page.textContent('#taskList');
  ok(tl.includes('commercialista') && !tl.includes('Comprare il pane'), 'filtro priorità alta');
  await page.selectOption('#fState', 'open'); await page.selectOption('#fPrio', '');
  await page.click('#btnStats');
  const st = await page.textContent('#v-stats');
  ok(/1\s*completate/.test(st) && st.includes('1/7 questa settimana') && st.includes('record 1'), 'statistiche settimanali');
  for (const btn of ['#btnSearch', '#btnStats']) {
    await page.click(btn);
    const small = await page.evaluate(() => [...document.querySelectorAll('button,input,select,textarea')]
      .filter((el) => el.offsetParent !== null && !el.closest('dialog'))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map((el) => el.outerHTML.slice(0, 60)));
    ok(small.length === 0, `aree di tocco ≥44px in ${btn} ${small.length ? JSON.stringify(small) : ''}`);
  }
  await page.click('#btnStats');
  await page.screenshot({ path: 'stats.png' });

  // Aree di tocco e tema
  for (const v of ['oggi', 'attivita', 'agenda', 'abitudini', 'note', 'ai']) {
    await page.click(`#nav [data-view=${v}]`);
    const small = await page.evaluate(() => [...document.querySelectorAll('button,input,select,textarea')]
      .filter((el) => el.offsetParent !== null && !el.closest('dialog'))
      .map((el) => { const r = el.getBoundingClientRect(); return { n: el.outerHTML.slice(0, 60), w: r.width, h: r.height }; })
      .filter((r) => r.w < 44 || r.h < 44));
    ok(small.length === 0, `aree di tocco ≥44px in ${v} ` + (small.length ? JSON.stringify(small) : ''));
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `nessuno scroll orizzontale in ${v}`);
  }
  await page.setViewportSize({ width: 320, height: 640 });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nessuno scroll orizzontale a 320px');
  await page.setViewportSize({ width: 412, height: 839 });
  await page.evaluate(() => { localStorage.setItem('segretaria.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('segretaria.settings')), theme: 'dark' })); });
  await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  const bg = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, document.querySelector('meta[name=theme-color]').content]);
  ok(bg[0] === 'rgb(18, 22, 20)' && bg[1] === '#121614', 'tema scuro applicato ' + bg);
  await page.click('#nav [data-view=oggi]');
  await page.screenshot({ path: 'dark.png' });
  await page.click('#nav [data-view=ai]');
  await page.screenshot({ path: 'screen.png' });
  ok(errors.length === 0, 'console senza errori ' + JSON.stringify(errors));
  await browser.close();
  console.log(fails ? `\n${fails} FALLITI` : '\nTUTTO OK');
  process.exit(fails ? 1 : 0);
})();
