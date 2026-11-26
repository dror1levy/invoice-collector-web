// The desktop web view of the app: reads the phone's database backup from Google Drive (view
// only) and shows the periods, invoices and the suppliers & products dashboard.
import { CONFIG } from './config.js?v=7';
import { Data } from './data.js?v=7';
import { timeChart } from './charts.js?v=7';
import { account, matchAll, merge, parseStatement } from './card.js?v=7';
import { GMAIL_SCOPE, findInvoices } from './gmail.js?v=7';
import {
  ALL_KINDS, EXCLUDED, FIXED, OCCASIONAL, PRODUCTS, RUNNING, cumulative, displayDate, displayPeriod, parsePeriod,
  quantityByMonth, sameDayTogether, withVat,
} from './logic.js?v=7';

const SQL_JS = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const state = { data: null, token: null, backupTime: null, source: null, vat: localGet('vat') === '1', fileCache: new Map() };

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

// --- tiny DOM helper -------------------------------------------------------------------------
function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const ltr = (t) => h('bdi', { dir: 'ltr' }, t);
const billing = (d) => { const t = displayPeriod(d.billing_start, d.billing_end); return t && ltr(t); };
const money = (v) => (v == null ? '—' : (v < 0 ? '-₪' : '₪') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qty = (q) => (Number.isInteger(q) ? q.toLocaleString('en-US') : q.toLocaleString('en-US', { maximumFractionDigits: 2 }));
const pct = (p) => (p > 0 ? '+' : '') + p.toFixed(1) + '%';

const KIND_LABEL = { [FIXED]: 'הוצאה קבועה', [PRODUCTS]: 'ספקים', [RUNNING]: 'דלק / שוטפות', [OCCASIONAL]: 'ארעי' };
const KIND_TONE = { [FIXED]: 'info', [PRODUCTS]: 'success', [RUNNING]: 'primary', [OCCASIONAL]: 'neutral' };
const STATUS = { pending: 'ממתין', extracted: 'נקרא', needs_review: 'לבדיקה', confirmed: 'אושר', not_invoice: 'לא חשבונית מס', failed: 'נכשל', duplicate: 'כפולה (נמחקה)' };
const DOC_TYPE = { tax_invoice: 'חשבונית מס', tax_invoice_receipt: 'חשבונית מס קבלה', receipt: 'קבלה', credit_note: 'חשבונית זיכוי', other: 'אחר' };

const pill = (text, tone = 'neutral') => h('span', { class: `pill ${tone}` }, text);
const kindPill = (g) => pill(g ? KIND_LABEL[g.kind] ?? g.kind : 'לא משויך', g ? KIND_TONE[g.kind] : 'warning');
const card = (title, ...body) => h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...body);
const kpis = (items) => h('div', { class: 'kpis' }, items.filter(Boolean).map(([label, value]) => h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value))));

function changePill(p) {
  if (p == null) return null;
  if (Math.abs(p) < 0.05) return pill('ללא שינוי');
  return p > 0 ? h('span', { class: 'pill danger' }, '▲ ', ltr(pct(p))) : h('span', { class: 'pill success' }, '▼ ', ltr(pct(p)));
}

// VAT display: amounts are stored before VAT; with the switch on they are shown with VAT of their date.
const shown = (beforeVat, date) => (beforeVat == null ? null : state.vat ? withVat(beforeVat, date) : beforeVat);
const vatNote = () => h('p', { class: 'note' }, state.vat ? 'המחירים כולל מע״מ (לפי שיעור המע״מ בתאריך הקנייה).' : 'המחירים לפני מע״מ.');

function vatSwitch() {
  const opt = (on, label) => h('button', { class: 'seg' + (state.vat === on ? ' on' : ''), onclick: () => { state.vat = on; localSet('vat', on ? '1' : '0'); render(); } }, label);
  return h('div', { class: 'segmented', role: 'group', 'aria-label': 'מע״מ' }, opt(false, 'לפני מע״מ'), opt(true, 'כולל מע״מ'));
}

function modes(options, selected, onSelect) {
  return h('div', { class: 'segmented' }, options.map((label, i) => h('button', { class: 'seg' + (i === selected ? ' on' : ''), onclick: () => onSelect(i) }, label)));
}

// --- Google sign-in and the backup ----------------------------------------------------------
// Signed in once, the page stays signed in until "התנתק": Google's access token (valid about an
// hour) is kept in this browser, and so is the last copy of the data, so a refresh shows it at
// once. After the hour, "רענן" gets a new token without asking again (the access was already granted).
let tokenClient;
const AUTH_KEY = 'auth', SIGNED_IN_KEY = 'signedIn';

function savedToken() {
  try {
    const a = JSON.parse(localGet(AUTH_KEY) ?? 'null');
    if (!(a && a.expires > Date.now() + 60000)) return null;
    state.scopes = a.scopes ?? '';
    return a.token;
  } catch { return null; }
}

function signIn(extraScope) {
  if (!CONFIG.clientId) { show(errorView('חסר מזהה OAuth לאתר (config.js). אפשר בינתיים לפתוח קובץ גיבוי מהמחשב.')); return; }
  tokenClient ??= google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.clientId, scope: SCOPE, include_granted_scopes: true,
    callback: (resp) => {
      if (resp.error) { show(errorView('ההתחברות נכשלה: ' + resp.error)); return; }
      state.token = resp.access_token;
      state.scopes = resp.scope ?? '';
      localSet(AUTH_KEY, JSON.stringify({ token: resp.access_token, scopes: state.scopes, expires: Date.now() + (+resp.expires_in || 3600) * 1000 }));
      localSet(SIGNED_IN_KEY, '1');
      if (state.data && state.afterSignIn) { const next = state.afterSignIn; state.afterSignIn = null; render(); next(); }
      else loadFromDrive();
    },
  });
  // A returning user already granted access: Google's window only flashes, no questions.
  const scope = extraScope ? `${SCOPE} ${extraScope}` : undefined;
  tokenClient.requestAccessToken({ ...(localGet(SIGNED_IN_KEY) === '1' && !extraScope ? { prompt: '' } : {}), ...(scope ? { scope } : {}) });
}

function signOut() {
  if (state.token) { try { google.accounts.oauth2.revoke(state.token, () => {}); } catch { /* offline */ } }
  state.token = null;
  state.data = null;
  try { localStorage.removeItem(AUTH_KEY); localStorage.removeItem(SIGNED_IN_KEY); } catch { /* */ }
  cache.clear();
  history.replaceState(null, '', location.pathname);
  render();
}

// The last data downloaded, kept in this browser (IndexedDB) so a refresh doesn't need Google.
const cache = {
  db() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('invoice-collector', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('backup');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('backup', mode);
      const req = fn(tx.objectStore('backup'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  async get() { try { return await this.run('readonly', (s) => s.get('last')); } catch { return null; } },
  async put(bytes, time) { try { await this.run('readwrite', (s) => s.put({ bytes, time }, 'last')); } catch { /* private mode */ } },
  async clear() { try { await this.run('readwrite', (s) => s.clear()); } catch { /* */ } },
};

async function drive(url) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + state.token } });
  if (r.status === 401) {
    // The token ran out: forget it; "רענן" / "התחבר" gets a new one.
    state.token = null;
    try { localStorage.removeItem(AUTH_KEY); } catch { /* */ }
    throw new Error('החיבור ל-Google פג. לחץ "רענן" כדי להתחבר שוב.');
  }
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

async function loadFromDrive() {
  show(loadingView('טוען את הנתונים מ-Drive…'));
  try {
    const q = encodeURIComponent("appProperties has { key='role' and value='database-backup' } and trashed=false");
    const list = await (await drive(`${DRIVE}?q=${q}&fields=files(id,modifiedTime,size)&spaces=drive`)).json();
    const file = list.files?.[0];
    if (!file) { show(errorView('לא נמצא גיבוי של האפליקציה ב-Drive. פתח את האפליקציה בטלפון, והגיבוי ייווצר אחרי הקריאה הבאה.')); return; }
    const bytes = new Uint8Array(await (await drive(`${DRIVE}/${file.id}?alt=media`)).arrayBuffer());
    await cache.put(bytes, file.modifiedTime);
    await open(bytes, 'drive', file.modifiedTime);
    loadPending();
  } catch (e) {
    show(errorView(String(e.message ?? e)));
  }
}

async function openFile(file) {
  show(loadingView('פותח את הקובץ…'));
  await open(new Uint8Array(await file.arrayBuffer()), 'file', new Date(file.lastModified).toISOString());
}

let SQL;
async function open(bytes, source, time) {
  SQL ??= await window.initSqlJs({ locateFile: (f) => SQL_JS + f });
  state.data = new Data(new SQL.Database(bytes));
  state.source = source;
  state.backupTime = time;
  render();
}

// --- screens -------------------------------------------------------------------------------
const root = () => document.getElementById('app');
function show(...nodes) { root().replaceChildren(...nodes); }

function loadingView(text) { return h('div', { class: 'center' }, h('div', { class: 'spinner' }), h('p', {}, text)); }
function errorView(text) { return h('div', { class: 'center' }, card(null, h('p', { class: 'error' }, text)), welcomeActions()); }

function welcomeActions() {
  const input = h('input', { type: 'file', accept: '.db,application/x-sqlite3,application/octet-stream', hidden: true, onchange: (e) => e.target.files[0] && openFile(e.target.files[0]) });
  return h('div', { class: 'actions' },
    h('button', { class: 'primary', onclick: () => signIn() }, 'התחבר עם Google'),
    h('button', { class: 'text', onclick: () => input.click() }, 'פתח קובץ גיבוי מהמחשב'), input);
}

function welcome() {
  return h('div', { class: 'center welcome' },
    h('h1', {}, 'איסוף חשבוניות'),
    h('p', {}, 'צפייה במחשב בנתונים של האפליקציה: תקופות, חשבוניות, ספקים ומוצרים. הנתונים נקראים מהגיבוי של האפליקציה ב-Google Drive שלך, ונשארים רק בדפדפן הזה.'),
    welcomeActions());
}

function topBar(active) {
  const fresh = state.backupTime ? `${state.source === 'dev' ? 'עותק בדיקה מקומי, ' : ''}נתונים מ-${new Date(state.backupTime).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}` : '';
  return h('header', { class: 'top' },
    h('div', { class: 'brand' }, h('a', { href: '#/' }, 'איסוף חשבוניות'), h('span', { class: 'fresh' }, fresh)),
    h('nav', {}, h('a', { href: '#/', class: active === 'invoices' ? 'on' : '' }, 'חשבוניות'), h('a', { href: '#/products', class: active === 'products' ? 'on' : '' }, 'ספקים ומוצרים'),
      h('a', { href: '#/card', class: active === 'card' ? 'on' : '' }, 'כרטיס אשראי')),
    ['drive', 'cache'].includes(state.source) ? h('div', { class: 'top-actions' },
      h('button', { class: 'text', onclick: () => (state.token ? loadFromDrive() : signIn()), title: 'טען שוב את הגיבוי מ-Drive' }, 'רענן'),
      h('button', { class: 'text', onclick: signOut, title: 'התנתק ומחק את הנתונים מהדפדפן הזה' }, 'התנתק')) : null);
}

function page(active, title, subtitle, sticky, ...body) {
  return [h('div', { class: 'head' }, topBar(active), sticky ? h('div', { class: 'sticky' }, sticky) : null),
    h('main', {}, title ? h('div', { class: 'title' }, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null) : null, ...body)];
}

// Home: the periods.
function homeView() {
  const periods = state.data.periods();
  return page('invoices', 'תקופות דיווח', null, null,
    h('div', { class: 'toolbar' }, h('a', { class: 'button tonal', href: '#/upload' }, '⬆ העלאת חשבוניות'), h('a', { class: 'button tonal', href: '#/gmail' }, '✉ ייבוא מהמייל')),
    h('div', { class: 'grid' }, periods.map((p) => h('a', { class: 'card link period', href: `#/period/${p.folder_name}` },
      h('div', { class: 'period-head' }, h('h2', {}, ltr(p.period?.label ?? p.folder_name)), h('span', { class: 'muted' }, p.period?.year ?? '')),
      h('div', { class: 'big' }, money(p.total)),
      h('div', { class: 'muted' }, `${p.count} חשבוניות`),
      h('div', { class: 'pills' },
        p.review ? pill(`${p.review} לבדיקה`, 'danger') : null,
        p.missingFixed ? pill(`${p.missingFixed} קבועות חסרות`, 'warning') : pill('הקבועות מלאות', 'success'),
        p.unassigned ? pill(`${p.unassigned} לא משויכות`, 'warning') : null,
        p.pending ? pill(`${p.pending} ממתינות`, 'info') : null,
        pendingIn(p.folder_name).length ? pill(`${pendingIn(p.folder_name).length} הועלו, ממתינות לטלפון`, 'info') : null)))),
    newPendingPeriods(periods));
}

// One period.
function periodView(folder) {
  const p = state.data.periods().find((x) => x.folder_name === folder);
  if (!p) {
    const waiting = pendingCard(folder);
    return waiting ? page('invoices', `תקופה ${parsePeriod(folder)?.label ?? folder}`, String(parsePeriod(folder)?.year ?? ''), null, waiting) : page('invoices', 'התקופה לא נמצאה', null, null);
  }
  const docs = p.documents;
  const row = (d) => h('a', { class: 'row', href: `#/doc/${d.id}` },
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, d.supplier_name ?? ltr(d.file_name)),
      h('div', { class: 'muted' }, [d.invoice_date ? displayDate(d.invoice_date) : null, d.invoice_number ? '#' + d.invoice_number : null].filter(Boolean).join(' · '))),
    h('div', { class: 'row-end' }, h('div', { class: 'amount' }, money(d.total)),
      d.invoice_id != null && !['not_invoice', 'duplicate'].includes(d.status) ? kindPill(d.group) : pill(STATUS[d.status] ?? d.status)));
  const section = (title, list, tone, grouped) => list.length ? h('details', { class: 'card section', open: tone === 'danger' },
    h('summary', {}, h('span', {}, title), pill(String(list.length), tone ?? 'neutral')),
    grouped
      ? [...ALL_KINDS, null].map((kind) => {
        const inKind = list.filter((d) => (kind == null ? !d.group || !ALL_KINDS.includes(d.group.kind) : d.group?.kind === kind));
        if (!inKind.length) return null;
        return [h('h3', { class: `kind ${kind ? KIND_TONE[kind] : 'warning'}` }, `${kind ? KIND_LABEL[kind] : 'לא משויך'} · ${inKind.length}`),
          inKind.sort((a, b) => (a.supplier_name ?? a.file_name).localeCompare(b.supplier_name ?? b.file_name, 'he') || (a.invoice_date ?? '').localeCompare(b.invoice_date ?? '')).map(row)];
      })
      : list.sort((a, b) => (a.invoice_date ?? a.file_name).localeCompare(b.invoice_date ?? b.file_name)).map(row)) : null;

  const fixed = card('הוצאות קבועות', h('div', { class: 'list' }, p.checklist.map((c) => {
    const mine = c.ids.map((id) => docs.find((d) => d.id === id)).filter(Boolean);
    return h('details', { class: 'fixed' },
      h('summary', {}, h('span', { class: 'row-title' }, c.item.title),
        !c.linked ? pill('לא משויך ספק', 'warning') : c.complete ? pill(`${c.found} מתוך ${c.item.expectedPerPeriod}`, 'success') : pill(`${c.found} מתוך ${c.item.expectedPerPeriod}`, 'danger')),
      mine.map((d) => h('a', { class: 'row sub', href: `#/doc/${d.id}` },
        h('div', { class: 'row-main' }, ltr(displayPeriod(d.billing_start, d.billing_end) ?? displayDate(d.invoice_date) ?? d.file_name),
          h('div', { class: 'muted' }, displayPeriod(d.billing_start, d.billing_end) ? 'תקופת חשבון' : 'תאריך חשבונית')),
        h('div', { class: 'amount' }, money(d.total)))));
  })));

  return page('invoices', `תקופה ${p.period?.label ?? folder}`, String(p.period?.year ?? ''), null,
    h('section', { class: 'card hero' }, kpis([['סה״כ', money(p.total)], ['לפני מע״מ', money(p.beforeVat)], ['מע״מ', money(p.vat)], ['חשבוניות', String(p.count)]])),
    h('div', { class: 'toolbar' },
      h('a', { class: 'button tonal', href: `#/upload?period=${folder}` }, '⬆ העלאת חשבוניות לתקופה'),
      h('a', { class: 'button tonal', href: `#/gmail?period=${folder}` }, '✉ ייבוא מהמייל'),
      h('a', { class: 'button tonal', href: `#/card/${folder}` }, 'הצלבה מול כרטיס אשראי'),
      h('button', { class: 'button tonal', onclick: () => exportPeriod(p) }, '⬇ ייצוא ל-Excel')),
    pendingCard(folder),
    fixed,
    section('לבדיקה', docs.filter((d) => d.status === 'needs_review' || d.status === 'failed'), 'danger'),
    section('נקראו', docs.filter((d) => d.status === 'extracted' || d.status === 'confirmed'), 'neutral', true),
    section('ממתינות לקריאה', docs.filter((d) => d.status === 'pending'), 'info'),
    section('לא חשבוניות מס', docs.filter((d) => d.status === 'not_invoice')),
    section('כפולות', docs.filter((d) => d.status === 'duplicate')));
}

// One document: the file next to what was read from it.
function docView(id) {
  const d = state.data.document(id);
  if (!d) return page('invoices', 'המסמך לא נמצא', null, null);
  const preview = h('div', { class: 'preview' }, h('p', { class: 'muted' }, 'טוען את הקובץ…'));
  loadPreview(d, preview);
  const field = (label, value) => value == null || value === '' ? null : h('div', { class: 'field' }, h('div', { class: 'muted' }, label), h('div', {}, value));
  const lines = d.lines?.length ? card('שורות', h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'תיאור'), h('th', {}, 'כמות'), h('th', {}, 'מחיר ליח׳ (לפני מע״מ)'), h('th', {}, 'סה״כ (לפני מע״מ)'))),
    h('tbody', {}, d.lines.map((l) => h('tr', {}, h('td', {}, l.description), h('td', {}, l.quantity == null ? '' : qty(l.quantity)), h('td', {}, money(l.unit_price_before_vat)), h('td', {}, money(l.line_total_before_vat))))))) : null;
  return page('invoices', d.supplier_name ?? d.file_name, [STATUS[d.status], d.folder_name ? `תקופה ${parsePeriod(d.folder_name)?.label ?? d.folder_name}` : null].filter(Boolean).join(' · '), null,
    h('div', { class: 'split' }, preview, h('div', {},
      card('פרטי החשבונית',
        field('ספק', d.supplier_name), field('ח.פ / עוסק', d.supplier_tax_id && ltr(d.supplier_tax_id)), field('סוג מסמך', DOC_TYPE[d.doc_type] ?? d.doc_type),
        field('מספר', d.invoice_number && ltr(d.invoice_number)), field('תאריך', displayDate(d.invoice_date)), field('תקופת חשבון', billing(d)),
        field('תיאור', d.description), field('לפני מע״מ', d.amount_before_vat != null ? money(d.amount_before_vat) : null), field('מע״מ', d.vat_amount != null ? money(d.vat_amount) : null),
        field('סה״כ', d.total != null ? money(d.total) : null), field('קבוצה', d.group ? `${d.group.title} (${KIND_LABEL[d.group.kind]})` : d.invoice_id != null ? 'לא משויך' : null),
        d.issues.length ? field('לבדיקה', d.issues.join(', ')) : null, field('קובץ', ltr(d.file_name)),
        h('a', { class: 'text', href: `https://drive.google.com/file/d/${d.drive_file_id}/view`, target: '_blank', rel: 'noopener' }, 'פתח ב-Drive ↗')),
      lines)));
}

async function loadPreview(d, box) {
  if (!state.token) {
    box.replaceChildren(h('p', { class: 'muted' }, 'תצוגת הקובץ זמינה אחרי התחברות עם Google. '), h('a', { href: `https://drive.google.com/file/d/${d.drive_file_id}/view`, target: '_blank', rel: 'noopener' }, 'פתח ב-Drive ↗'));
    return;
  }
  try {
    let url = state.fileCache.get(d.drive_file_id);
    if (!url) {
      const blob = await (await drive(`${DRIVE}/${d.drive_file_id}?alt=media`)).blob();
      url = URL.createObjectURL(new Blob([blob], { type: d.mime_type }));
      state.fileCache.set(d.drive_file_id, url);
    }
    box.replaceChildren(d.mime_type === 'application/pdf' ? h('iframe', { src: url, title: d.file_name }) : h('img', { src: url, alt: d.file_name }));
  } catch (e) {
    box.replaceChildren(h('p', { class: 'error' }, 'לא הצלחתי לטעון את הקובץ: ' + e.message));
  }
}

// --- suppliers & products -------------------------------------------------------------------
const matches = (p, q) => p.name.toLowerCase().includes(q.toLowerCase()) || (p.sku ?? '').includes(q);

function productRow(s, p) {
  return h('a', { class: 'row', href: `#/product/${s.groupId}/${encodeURIComponent(p.key)}` },
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, p.name), h('div', { class: 'muted' }, `${p.purchaseCount} קניות · סה״כ ${qty(p.totalQuantity)} יח׳`)),
    h('div', { class: 'row-end' }, h('div', { class: 'amount' }, money(shown(p.lastPrice, p.lastDate))), changePill(p.lastChangePercent)));
}

function spendingCard(title, points, total, key) {
  const box = h('div', { class: 'chart' });
  const mode = +(sessionStorage.getItem('mode:' + key) ?? 0);
  const drawChart = (m) => {
    if (m === 0) timeChart(box, points, { mark: 'bars', format: money });
    else {
      const run = cumulative(points.map((p) => p.value));
      timeChart(box, points.map((p, i) => ({ ...p, value: run[i], detail: null })), { mark: 'line', format: money, fromZero: true });
    }
  };
  const switcher = h('div');
  const setMode = (m) => { try { sessionStorage.setItem('mode:' + key, m); } catch { /* */ } switcher.replaceChildren(modes(['כל רכישה', 'מצטבר'], m, setMode)); drawChart(m); };
  const c = card(title, points.length ? [h('div', { class: 'muted' }, 'סה״כ רכישות מאז ומעולם'), h('div', { class: 'big' }, money(total)), switcher, box, vatNote()] : h('p', { class: 'muted' }, 'אין סכומים להצגה.'));
  if (points.length) requestAnimationFrame(() => setMode(mode));
  return c;
}

function productsView(query = '') {
  const suppliers = state.data.catalog();
  const search = h('input', { type: 'search', class: 'search', placeholder: 'חיפוש מוצר או ברקוד', value: query, oninput: (e) => { history.replaceState(null, '', `#/products?q=${encodeURIComponent(e.target.value)}`); renderResults(e.target.value); } });
  const results = h('div');
  const renderResults = (q) => {
    q = q.trim();
    if (q) {
      const hits = suppliers.flatMap((s) => s.products.filter((p) => matches(p, q)).map((p) => [s, p])).sort((a, b) => b[1].purchaseCount - a[1].purchaseCount);
      results.replaceChildren(card(`תוצאות (${hits.length})`, hits.map(([s, p]) => [h('div', { class: 'supplier-tag' }, s.title), productRow(s, p)])));
    } else {
      results.replaceChildren(card('ספקים', [...suppliers].sort((a, b) => (state.vat ? b.totalWithVat - a.totalWithVat : b.totalBeforeVat - a.totalBeforeVat)).map((s) => h('a', { class: 'row', href: `#/supplier/${s.groupId}` },
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, s.title), h('div', { class: 'muted' }, [`${s.products.length} מוצרים`, s.lastPurchase ? `קנייה אחרונה: ${displayDate(s.lastPurchase)}` : null].filter(Boolean).join(' · '))),
        h('div', { class: 'amount' }, money(state.vat ? s.totalWithVat : s.totalBeforeVat))))));
    }
  };
  renderResults(query);
  return page('products', 'ספקים ומוצרים', null, vatSwitch(),
    h('section', { class: 'card hero' }, kpis([
      ['ספקים', String(suppliers.length)], ['מוצרים', String(suppliers.reduce((s, x) => s + x.products.length, 0))],
      ['סה״כ רכישות מאז ומעולם', money(suppliers.reduce((s, x) => s + (state.vat ? x.totalWithVat : x.totalBeforeVat), 0))],
      ['חשבוניות', String(suppliers.reduce((s, x) => s + x.invoices.length, 0))]])),
    h('div', { class: 'toolbar' }, h('button', { class: 'button tonal', onclick: () => exportCatalog(suppliers) }, '⬇ ייצוא ספקים ומוצרים ל-Excel')),
    search, results);
}

function supplierView(groupId) {
  const s = state.data.catalog().find((x) => x.groupId === groupId);
  if (!s) return page('products', 'הספק לא נמצא', null, vatSwitch());
  const points = sameDayTogether(s.invoices.filter((i) => i.date && (state.vat ? i.total : i.amountBeforeVat) != null)
    .map((i) => ({ date: i.date.slice(0, 10), value: state.vat ? i.total : i.amountBeforeVat, detail: i.number ? '#' + i.number : null })), (n) => `${n} חשבוניות`);
  const search = h('input', { type: 'search', class: 'search', placeholder: 'חיפוש מוצר או ברקוד' });
  const list = h('div');
  const renderList = (q) => {
    const items = q.trim() ? s.products.filter((p) => matches(p, q.trim())) : s.products;
    list.replaceChildren(card(`המוצרים של הספק (${items.length})`, items.map((p) => productRow(s, p))));
  };
  search.addEventListener('input', (e) => renderList(e.target.value));
  renderList('');
  return page('products', s.title, null, vatSwitch(),
    h('section', { class: 'card hero' }, kpis([
      ['סה״כ לפני מע״מ', money(s.totalBeforeVat)], ['סה״כ כולל מע״מ', money(s.totalWithVat)], ['חשבוניות', String(s.invoices.length)],
      ['מוצרים', String(s.products.length)], s.firstPurchase && ['קנייה ראשונה', displayDate(s.firstPurchase)], s.lastPurchase && ['קנייה אחרונה', displayDate(s.lastPurchase)]])),
    spendingCard('סכום כל רכישה לאורך זמן', points, state.vat ? s.totalWithVat : s.totalBeforeVat, 'supplier'),
    s.notes ? card('פירוט מתעודות משלוח',
      h('p', { class: 'muted' }, 'החשבוניות של הספק לא מפרטות מוצרים; הפריטים נלקחים מתעודות המשלוח התואמות (נאספות בטלפון).'),
      kpis([['תעודות משלוח שנקראו', String(s.notes.notes)], ['חשבוניות עם פירוט', `${s.notes.matchedInvoices} מתוך ${s.invoices.length}`]])) : null,
    s.products.length ? [search, list] : null);
}

function productView(groupId, key) {
  const s = state.data.catalog().find((x) => x.groupId === groupId);
  const p = s?.products.find((x) => x.key === key);
  if (!p) return page('products', 'המוצר לא נמצא', null, vatSwitch());
  const spent = p.purchases.reduce((t, b) => t + (b.amount != null ? shown(b.amount, b.date) : 0), 0);
  const dated = p.purchases.filter((b) => b.date);
  const spending = sameDayTogether(dated.filter((b) => b.amount != null).map((b) => ({ date: b.date.slice(0, 10), value: shown(b.amount, b.date), detail: b.quantity != null ? `${qty(b.quantity)} יח׳` : null })), (n) => `${n} רכישות`);
  const prices = [...new Map(dated.filter((b) => b.unitPrice != null).map((b) => [b.date.slice(0, 10), { date: b.date.slice(0, 10), value: shown(b.unitPrice, b.date) }])).values()];
  const months = quantityByMonth(p).map(([m, q]) => ({ date: m + '-01', value: q }));
  const priceBox = h('div', { class: 'chart' }), qtyBox = h('div', { class: 'chart' });
  requestAnimationFrame(() => {
    timeChart(priceBox, prices, { mark: 'line', format: money });
    timeChart(qtyBox, months, { mark: 'bars', format: (v) => `${qty(v)} יח׳` });
  });
  return page('products', p.name, s.title, vatSwitch(),
    h('section', { class: 'card hero' },
      h('div', { class: 'muted' }, state.vat ? 'מחיר אחרון ליחידה (כולל מע״מ)' : 'מחיר אחרון ליחידה (לפני מע״מ)'),
      h('div', { class: 'big' }, money(shown(p.lastPrice, p.lastDate)), ' ', changePill(p.lastChangePercent)),
      kpis([['סה״כ רכישות מאז ומעולם', money(spent)], ['סה״כ הוזמנו', qty(p.totalQuantity)], ['קניות', String(p.purchaseCount)], p.lastDate && ['קנייה אחרונה', displayDate(p.lastDate)]]),
      p.sku ? h('p', { class: 'muted' }, 'ברקוד / מק״ט: ', ltr(p.sku)) : null),
    spendingCard('סכום כל רכישה של המוצר', spending, spent, 'product'),
    h('div', { class: 'two' },
      card('מחיר ליחידה לאורך זמן', prices.length ? priceBox : h('p', { class: 'muted' }, 'אין מחירים בחשבוניות של המוצר.')),
      card('כמות שהוזמנה בכל חודש', months.length ? qtyBox : h('p', { class: 'muted' }, 'אין כמויות בחשבוניות של המוצר.'))),
    card('כל הקניות', h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'תאריך'), h('th', {}, 'חשבונית'), h('th', {}, 'כמות'), h('th', {}, 'מחיר ליח׳'), h('th', {}, 'סכום'))),
      h('tbody', {}, [...p.purchases].reverse().map((b) => h('tr', {},
        h('td', {}, displayDate(b.date) ?? '—'), h('td', {}, h('a', { href: `#/doc/${b.documentId}` }, b.invoiceNumber ? '#' + b.invoiceNumber : 'פתח')),
        h('td', {}, b.quantity == null ? '' : qty(b.quantity)), h('td', {}, money(shown(b.unitPrice, b.date))), h('td', {}, money(shown(b.amount, b.date))))))), vatNote()));
}

// --- Excel (SheetJS, loaded only when needed) ------------------------------------------------
let xlsxLoading;
function loadXlsx() {
  xlsxLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxLoading = null; reject(new Error('לא הצלחתי לטעון את רכיב ה-Excel')); };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

async function saveWorkbook(fileName, sheets) {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  for (const [name, rows] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = rows[0].map((_, c) => ({ wch: Math.min(45, Math.max(8, ...rows.map((r) => String(r[c] ?? '').length + 2))) }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, fileName);
}

function exportPeriod(p) {
  const docs = [...p.documents].sort((a, b) => (a.invoice_date ?? '').localeCompare(b.invoice_date ?? ''));
  const rows = [['סטטוס', 'ספק', 'ח.פ / עוסק', 'סוג מסמך', 'מספר', 'תאריך', 'תקופת חשבון', 'תיאור', 'קבוצה', 'סוג הוצאה', 'לפני מע״מ', 'מע״מ', 'סה״כ', 'קובץ', 'קישור']];
  for (const d of docs) {
    rows.push([STATUS[d.status] ?? d.status, d.supplier_name ?? '', d.supplier_tax_id ?? '', DOC_TYPE[d.doc_type] ?? d.doc_type ?? '', d.invoice_number ?? '',
      displayDate(d.invoice_date) ?? '', displayPeriod(d.billing_start, d.billing_end) ?? '', d.description ?? '', d.group?.title ?? '', d.group ? KIND_LABEL[d.group.kind] ?? '' : '',
      d.amount_before_vat ?? '', d.vat_amount ?? '', d.total ?? '', d.file_name, `https://drive.google.com/file/d/${d.drive_file_id}/view`]);
  }
  saveWorkbook(`חשבוניות ${p.period?.year ?? ''} ${p.period?.label ?? p.folder_name}.xlsx`, [['חשבוניות', rows]]).catch((e) => alertBox(e.message));
}

function exportCatalog(suppliers) {
  const sRows = [['ספק', 'חשבוניות', 'סה״כ לפני מע״מ', 'סה״כ כולל מע״מ', 'מוצרים', 'קנייה ראשונה', 'קנייה אחרונה']];
  const pRows = [['ספק', 'מוצר', 'ברקוד / מק״ט', 'קניות', 'סה״כ יחידות', 'מחיר אחרון ליח׳ (לפני מע״מ)', 'שינוי אחרון %', 'קנייה אחרונה', 'סה״כ רכישות (לפני מע״מ)']];
  for (const s of suppliers) {
    sRows.push([s.title, s.invoices.length, +s.totalBeforeVat.toFixed(2), +s.totalWithVat.toFixed(2), s.products.length, displayDate(s.firstPurchase) ?? '', displayDate(s.lastPurchase) ?? '']);
    for (const p of s.products) {
      const spent = p.purchases.reduce((t, b) => t + (b.amount ?? 0), 0);
      pRows.push([s.title, p.name, p.sku ?? '', p.purchaseCount, p.totalQuantity, p.lastPrice ?? '', p.lastChangePercent == null ? '' : +p.lastChangePercent.toFixed(1),
        displayDate(p.lastDate) ?? '', +spent.toFixed(2)]);
    }
  }
  saveWorkbook('ספקים ומוצרים.xlsx', [['ספקים', sRows], ['מוצרים', pRows]]).catch((e) => alertBox(e.message));
}

function alertBox(text) { root().prepend(h('div', { class: 'center' }, card(null, h('p', { class: 'error' }, text)))); }

// --- credit card check (the same matching as on the phone) -----------------------------------
const OUTCOME_ORDER = ['missing', 'matched', 'no_invoice', 'outside'];
state.card = { statements: [], error: null };

function invoicesForMatching() {
  return state.data.documents()
    .filter((d) => d.invoice_id != null && !EXCLUDED.includes(d.status))
    .map((d) => ({ documentId: d.id, supplierName: d.supplier_name, supplierTaxId: d.supplier_tax_id, date: d.invoice_date?.slice(0, 10) ?? null,
      total: d.total, groupId: d.group?.id ?? null, description: d.description, folder: d.folder_name }));
}

async function addStatements(files) {
  state.card.error = null;
  try {
    const XLSX = await loadXlsx();
    for (const f of files) {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const rows = wb.SheetNames.flatMap((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }));
      const txs = parseStatement(rows);
      if (!txs.length) { state.card.error = `בקובץ "${f.name}" לא זוהה פירוט עסקאות. כרגע נתמך הייצוא של ישראכרט (Excel).`; continue; }
      state.card.statements = state.card.statements.filter((s) => s.name !== f.name).concat([{ name: f.name, txs }]);
    }
  } catch (e) {
    state.card.error = 'לא הצלחתי לקרוא את הקובץ: ' + e.message;
  }
  render();
}

function cardView(folder) {
  const periods = state.data.periods();
  const p = periods.find((x) => x.folder_name === folder) ?? periods[0];
  if (!p) return page('card', 'הצלבה מול כרטיס אשראי', null, null, card(null, h('p', {}, 'אין עדיין תקופות.')));
  const input = h('input', { type: 'file', accept: '.xlsx,.xls,.csv', multiple: true, hidden: true, onchange: (e) => addStatements([...e.target.files]) });
  const drop = h('div', { class: 'dropzone', onclick: () => input.click(),
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
    ondragleave: (e) => e.currentTarget.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); addStatements([...e.dataTransfer.files]); } },
  h('strong', {}, state.card.statements.length ? 'הוסף קובץ נוסף (חודש חיוב נוסף)' : 'גרור לכאן את קובץ פירוט העסקאות, או לחץ לבחירה'),
  h('span', { class: 'muted' }, 'ייצוא Excel מאתר חברת האשראי. הקובץ נקרא בדפדפן בלבד ולא נשמר.'), input);
  const select = h('select', { class: 'select', onchange: (e) => { location.hash = `#/card/${e.target.value}`; } },
    periods.map((x) => h('option', { value: x.folder_name, selected: x === p ? true : null }, `תקופה ${x.period?.label ?? x.folder_name} ${x.period?.year ?? ''}`)));
  const files = state.card.statements.length ? h('div', { class: 'pills' }, state.card.statements.map((s) => h('span', { class: 'pill neutral' }, ltr(s.name), ` · ${s.txs.length} חיובים `,
    h('button', { class: 'pill-x', title: 'הסר', onclick: () => { state.card.statements = state.card.statements.filter((x) => x !== s); render(); } }, '✕')))) : null;
  const head = card(null, h('div', { class: 'toolbar' }, h('label', { class: 'muted' }, 'תקופה: '), select), drop, files,
    state.card.error ? h('p', { class: 'error' }, state.card.error) : null,
    state.card.statements.length === 1 ? h('p', { class: 'note' }, 'תקופה של חודשיים נפרסת בדרך כלל על שני דפי חיוב: הוסף גם את הקובץ של החודש השני.') : null);
  if (!state.card.statements.length) return page('card', 'הצלבה מול כרטיס אשראי', 'כל חיוב בכרטיס מול החשבונית שלו', null, head);

  const period = { year: p.period.year, start: p.period.start, end: p.period.end };
  const accounts = state.data.groups.filter((g) => g.onAccount).map(account);
  const m = matchAll(merge(state.card.statements.map((s) => s.txs)), invoicesForMatching(), period, accounts);
  const by = (o) => m.results.filter((r) => r.outcome === o).sort((a, b) => a.transaction.date.localeCompare(b.transaction.date));
  const [missing, matched, noInvoice, outside] = OUTCOME_ORDER.map(by);
  const inPeriodCount = m.results.length - outside.length;
  const sum = (list) => list.reduce((t, r) => t + r.transaction.amount, 0);
  const txRow = (r) => {
    const t = r.transaction, inv = r.invoice;
    const sub = [displayDate(t.date), t.details, inv ? `חשבונית: ${inv.supplierName ?? ''} · ${displayDate(inv.date) ?? ''}` : null].filter(Boolean).join(' · ');
    return h(inv ? 'a' : 'div', { class: 'row', href: inv ? `#/doc/${inv.documentId}` : null },
      h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, t.merchant), h('div', { class: 'muted' }, sub)), h('div', { class: 'amount' }, money(t.amount)));
  };
  const section = (title, list, tone, open, explain) => list.length ? h('details', { class: 'card section', open: open || null },
    h('summary', {}, h('span', {}, title), pill(String(list.length), tone)), explain ? h('p', { class: 'note' }, explain) : null, list.map(txRow)) : null;
  const pending = p.pending;

  return page('card', 'הצלבה מול כרטיס אשראי', `תקופה ${p.period.label} ${p.period.year}`, null, head,
    h('section', { class: 'card hero' },
      h('div', { class: 'big ' + (missing.length ? 'error' : '') }, missing.length ? `${missing.length} חיובים בלי חשבונית · ${money(sum(missing))}` : 'לכל החיובים בתקופה נמצאה חשבונית'),
      h('div', { class: 'muted' }, `${inPeriodCount} חיובים בתקופה · ${matched.length} מותאמים · ${noInvoice.length} לא צריכים חשבונית`),
      pending ? h('p', { class: 'error' }, `${pending} חשבוניות עוד לא נקראו בטלפון, וייתכן שחלק מהחיובים יתאימו אליהן אחרי הקריאה.`) : null),
    section('חיובים בלי חשבונית', missing, 'danger', true, 'לא נמצאה חשבונית באותו סכום, מ-45 יום לפני החיוב ועד 15 יום אחריו.'),
    m.accounts.map(accountCard),
    section('מותאמים', matched, 'success', false),
    section('לא צריך חשבונית', noInvoice, 'neutral', false, 'מסים, ביטוח לאומי, עמלות וחנויות חו״ל.'),
    section('מחוץ לתקופה', outside, 'neutral', false, 'חיובים בקובץ שהתאריך שלהם בתקופה אחרת.'));
}

/** A supplier on account: each card payment with the invoices that add up to it. */
function accountCard(b) {
  const uncovered = b.payments.filter((p) => !b.hints.get(p)).length;
  const name = b.payments[0]?.merchant || b.account.title;
  const invLine = (inv) => h('a', { class: 'row sub', href: `#/doc/${inv.documentId}` },
    h('div', { class: 'row-main' }, h('div', {}, inv.description ?? 'חשבונית'), h('div', { class: 'muted' }, displayDate(inv.date) ?? '')), h('div', { class: 'amount' }, money(inv.total)));
  return h('section', { class: 'card' },
    h('div', { class: 'period-head' }, h('h2', {}, `בהקפה: ${name}`), pill(uncovered ? 'חסרות חשבוניות' : 'מכוסה', uncovered ? 'danger' : 'success')),
    h('p', { class: 'muted' }, uncovered ? `ל-${uncovered} תשלומים לא נמצאו חשבוניות שמסתכמות בדיוק בסכום.` : 'לכל תשלום בכרטיס נמצאו החשבוניות שמסתכמות בו.'),
    b.payments.map((p) => {
      const covered = b.hints.get(p);
      return h('div', { class: 'payment' },
        h('div', { class: 'payment-head' }, h('div', {}, h('div', { class: 'amount big-amount' }, money(p.amount)), h('div', { class: 'muted' }, `שולם בכרטיס ב-${displayDate(p.date)}`)),
          pill(covered ? 'מכוסה' : 'חסרות חשבוניות', covered ? 'success' : 'danger')),
        covered ? covered.map(invLine) : h('p', { class: 'note' }, 'לא נמצאו חשבוניות שמסתכמות בדיוק בסכום הזה.'));
    }),
    b.unassigned.length ? h('details', { class: 'section' }, h('summary', {}, h('span', {}, `חשבוניות שלא שויכו לתשלום (${b.unassigned.length})`)),
      h('p', { class: 'note' }, 'עוד לא שולמו, או ששולמו בדף חיוב שלא הוספת.'), b.unassigned.map(invLine)) : null);
}

// --- uploading invoices from the computer (the phone reads them when the app opens) ----------
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const MAX_UPLOAD = 5 * 1024 * 1024;
const UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
state.uploads = [];

function periodOfDate(d) {
  const m = d.getMonth() + 1, start = m % 2 ? m : m - 1;
  return `${d.getFullYear()}-${String(start).padStart(2, '0')}-${String(start + 1).padStart(2, '0')}`;
}

function uploadView(chosen) {
  const known = state.data.periods().map((x) => x.folder_name);
  const now = periodOfDate(new Date());
  const options = [...new Set([now, ...known])].sort().reverse();
  const period = chosen && /^\d{4}-\d{2}-\d{2}$/.test(chosen) ? chosen : now;
  if (!options.includes(period)) options.unshift(period);
  const select = h('select', { class: 'select', onchange: (e) => history.replaceState(null, '', `#/upload?period=${e.target.value}`) },
    options.map((f) => h('option', { value: f, selected: f === period ? true : null }, `תקופה ${parsePeriod(f)?.label ?? f} ${parsePeriod(f)?.year ?? ''}`)));
  if (!state.token) {
    return page('invoices', 'העלאת חשבוניות', null, null, card(null, h('p', {}, 'כדי להעלות קבצים ל-Drive צריך להתחבר עם Google.'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => signIn() }, 'התחבר עם Google'))));
  }
  const input = h('input', { type: 'file', accept: UPLOAD_TYPES.join(','), multiple: true, hidden: true, onchange: (e) => uploadFiles([...e.target.files], select.value) });
  const drop = h('div', { class: 'dropzone', onclick: () => input.click(),
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
    ondragleave: (e) => e.currentTarget.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); uploadFiles([...e.dataTransfer.files], select.value); } },
  h('strong', {}, 'גרור לכאן חשבוניות (PDF או תמונה), או לחץ לבחירה'), h('span', { class: 'muted' }, 'הקבצים עולים לתיקיית התקופה ב-Drive.'), input);
  const list = state.uploads.length ? card('קבצים', state.uploads.map((u) => h('div', { class: 'row' },
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, ltr(u.file.name)), u.name ? h('div', { class: 'muted' }, 'נשמר בשם ', ltr(u.name)) : null,
      u.fileId ? readingLine(u.fileId) : null),
    pill(u.status, u.tone)))) : null;
  return page('invoices', 'העלאת חשבוניות', null, null,
    card(null, h('div', { class: 'toolbar' }, h('label', { class: 'muted' }, 'לתקופה: '), select), drop,
      h('p', { class: 'note' }, 'הטלפון קורא את הקבצים החדשים בפעם הבאה שפותחים את האפליקציה (או בלחיצה על "קרא חשבוניות"), ואחרי הקריאה הם יופיעו גם כאן.')),
    list);
}

async function sha256Hex(buf) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function driveList(q, fields) {
  const out = [];
  let pageToken = '';
  do {
    const r = await (await drive(`${DRIVE}?q=${encodeURIComponent(q)}&fields=nextPageToken,files(${fields})&pageSize=1000&spaces=drive${pageToken ? '&pageToken=' + pageToken : ''}`)).json();
    out.push(...(r.files ?? []));
    pageToken = r.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
async function folder(name, parent) {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${esc(name)}' and '${esc(parent)}' in parents and trashed=false`;
  const found = (await driveList(q, 'id'))[0];
  if (found) return found.id;
  const r = await fetch(DRIVE + '?fields=id', { method: 'POST', headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) });
  if (!r.ok) throw new Error(`Drive ${r.status}`);
  return (await r.json()).id;
}

async function uploadFiles(files, periodKey) {
  const period = parsePeriod(periodKey);
  if (!period || !files.length) return;
  const items = files.map((file) => ({ file, status: 'ממתין', tone: 'neutral' }));
  state.uploads = [...items, ...state.uploads];
  render();
  const set = (u, status, tone, name) => { u.status = status; u.tone = tone; if (name) u.name = name; render(); };
  try {
    const hashes = new Set((await driveList("appProperties has { key='app' and value='invoice-collector' } and trashed=false", 'appProperties'))
      .map((f) => f.appProperties?.sha256).filter(Boolean));
    const root = await folder('חשבוניות', 'root');
    const target = await folder(period.label, await folder(String(period.year), root));
    const taken = new Set((await driveList(`'${target}' in parents and trashed=false`, 'name')).map((f) => f.name.replace(/\.[^.]*$/, '')));
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    for (const u of items) {
      const f = u.file;
      if (!UPLOAD_TYPES.includes(f.type)) { set(u, 'לא PDF או תמונה', 'warning'); continue; }
      if (f.size > MAX_UPLOAD) { set(u, 'גדול מ-5MB: העלה מהטלפון', 'warning'); continue; }
      set(u, 'מעלה…', 'info');
      const buf = await f.arrayBuffer();
      const hash = await sha256Hex(buf);
      if (hashes.has(hash)) { set(u, 'כבר קיים', 'neutral'); continue; }
      let n = 1, stem;
      do { stem = `${day}_${String(n++).padStart(3, '0')}`; } while (taken.has(stem));
      taken.add(stem);
      const ext = (f.name.match(/\.([^.]+)$/)?.[1] ?? (f.type === 'application/pdf' ? 'pdf' : 'jpg')).toLowerCase();
      const name = `${stem}.${ext}`;
      const meta = { name, parents: [target], description: `הועלה מהאתר: ${f.name}`,
        appProperties: { app: 'invoice-collector', sha256: hash, period: period.year + '-' + period.label } };
      const body = new FormData();
      body.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
      body.append('file', new Blob([buf], { type: f.type }));
      const r = await fetch(`${UPLOAD_API}?uploadType=multipart&fields=id`, { method: 'POST', headers: { Authorization: 'Bearer ' + state.token }, body });
      if (!r.ok) { set(u, `שגיאה (${r.status})`, 'danger'); continue; }
      hashes.add(hash);
      u.fileId = (await r.json()).id;
      set(u, 'הועלה', 'success', name);
    }
    // Read them right away (the phone uses these readings instead of reading again).
    const uploaded = items.filter((u) => u.fileId).map((u) => u.fileId);
    if (uploaded.length) { await loadPending(); readPending(uploaded); }
  } catch (e) {
    items.filter((u) => ['ממתין', 'מעלה…'].includes(u.status)).forEach((u) => { u.status = 'שגיאה'; u.tone = 'danger'; });
    alertBox('ההעלאה נכשלה: ' + e.message);
    render();
  }
}

// --- importing from Gmail (links downloaded by the server function) ---------------------------
state.gmail = { period: null, busy: false, progress: null, result: null, error: null, picked: new Set() };

async function fetchLinkThroughServer(links) {
  if (!CONFIG.linkFetcher) return null;
  const r = await fetch(CONFIG.linkFetcher, { method: 'POST', headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ links }) });
  return r.ok ? r.json() : null;
}

async function searchGmail(periodKey) {
  const g = state.gmail;
  Object.assign(g, { period: periodKey, busy: true, progress: [0, 0], result: null, error: null });
  render();
  try {
    const period = parsePeriod(periodKey);
    const found = await findInvoices(state.token, period, fetchLinkThroughServer, (d, t) => { g.progress = [d, t]; render(); });
    const hashes = new Set((await driveList("appProperties has { key='app' and value='invoice-collector' } and trashed=false", 'appProperties'))
      .map((f) => f.appProperties?.sha256).filter(Boolean));
    const seen = new Set();
    let repeats = 0;
    for (const it of found.items) {
      if (!it.bytes) continue;
      it.hash = await sha256Hex(it.bytes);
      it.exists = hashes.has(it.hash);
      if (seen.has(it.hash)) { it.repeat = true; repeats++; }
      seen.add(it.hash);
    }
    g.result = { items: found.items.filter((i) => !i.repeat), ignored: found.ignored + repeats };
    g.picked = new Set(g.result.items.filter((i) => i.bytes && !i.exists && !i.locked));
  } catch (e) {
    g.error = String(e.message ?? e);
  }
  g.busy = false;
  render();
}

function gmailView(chosen) {
  const g = state.gmail;
  const known = state.data.periods().map((x) => x.folder_name);
  const now = periodOfDate(new Date());
  const period = chosen && /^\d{4}-\d{2}-\d{2}$/.test(chosen) ? chosen : g.period ?? now;
  const options = [...new Set([now, period, ...known])].sort().reverse();
  const select = h('select', { class: 'select', disabled: g.busy || null, onchange: (e) => { location.hash = `#/gmail?period=${e.target.value}`; } },
    options.map((f) => h('option', { value: f, selected: f === period ? true : null }, `תקופה ${parsePeriod(f)?.label ?? f} ${parsePeriod(f)?.year ?? ''}`)));
  const canRead = state.token && (state.scopes ?? '').includes(GMAIL_SCOPE);
  const start = () => {
    if (canRead) { searchGmail(period); return; }
    state.afterSignIn = () => searchGmail(period);
    signIn(GMAIL_SCOPE);
  };
  const head = card(null, h('div', { class: 'toolbar' }, h('label', { class: 'muted' }, 'תקופה: '), select,
    h('button', { class: 'primary', disabled: g.busy || null, onclick: start }, g.result && g.period === period ? 'חפש שוב' : 'חפש חשבוניות במייל')),
  h('p', { class: 'note' }, 'מיילים שהתקבלו בחודשי התקופה ומזכירים חשבונית: קבצים מצורפים, וגם חשבוניות שנשלחו כקישור להורדה. הגישה למייל היא לקריאה בלבד.'),
  !canRead ? h('p', { class: 'note' }, 'בפעם הראשונה Google תבקש לאשר לאתר לקרוא את המייל. אם יופיע מסך שהאפליקציה לא אומתה, זה תקין: לוחצים "המשך".') : null,
  g.busy ? h('div', { class: 'toolbar' }, h('div', { class: 'spinner small' }), h('span', {}, g.progress?.[1] ? `קורא מיילים… ${g.progress[0]} מתוך ${g.progress[1]}` : 'מחפש במייל…')) : null,
  g.error ? h('p', { class: 'error' }, g.error) : null);
  if (!g.result || g.period !== period) return page('invoices', 'ייבוא חשבוניות מהמייל', null, null, head);

  const items = g.result.items;
  const fresh = items.filter((i) => i.bytes && !i.exists && !i.locked);
  const exists = items.filter((i) => i.exists);
  const locked = items.filter((i) => i.locked && !i.exists);
  const linkOnly = items.filter((i) => i.linkOnly);
  const row = (i, check) => h('label', { class: 'row pick' },
    check ? h('input', { type: 'checkbox', checked: g.picked.has(i) || null, onchange: (e) => { e.target.checked ? g.picked.add(i) : g.picked.delete(i); render(); } }) : null,
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, i.linkOnly ? i.name : ltr(i.name)),
      h('div', { class: 'muted' }, [new Date(i.received).toLocaleDateString('he-IL'), i.from.replace(/<.*>/, '').replace(/"/g, '').trim(), i.subject].filter(Boolean).join(' · '))),
    i.link && !i.linkOnly ? pill('מקישור', 'info') : null,
    i.linkOnly ? h('a', { class: 'text', href: i.link, target: '_blank', rel: 'noopener noreferrer' }, 'פתח קישור ↗') : null);
  const section = (title, list, tone, check, explain) => list.length ? card(null, h('div', { class: 'period-head' }, h('h2', {}, title), pill(String(list.length), tone)),
    explain ? h('p', { class: 'note' }, explain) : null, list.map((i) => row(i, check))) : null;
  const doImport = () => {
    const files = [...g.picked].map((i) => new File([i.bytes], i.name, { type: i.type }));
    g.result = null;
    location.hash = `#/upload?period=${period}`;
    uploadFiles(files, period);
  };
  return page('invoices', 'ייבוא חשבוניות מהמייל', null, null, head,
    h('section', { class: 'card hero' },
      h('div', { class: 'big' }, fresh.length ? `${fresh.length} חשבוניות חדשות` : 'אין חשבוניות חדשות'),
      h('div', { class: 'muted' }, [`${exists.length} כבר ב-Drive`, locked.length ? `${locked.length} מוגנות בסיסמה` : null, linkOnly.length ? `${linkOnly.length} קישורים שלא ירדו` : null,
        g.result.ignored ? `${g.result.ignored} קבצים אחרים דולגו (לוגו, כפולות, תעודות משלוח)` : null].filter(Boolean).join(' · ')),
      fresh.length ? h('div', { class: 'toolbar' }, h('button', { class: 'primary', disabled: !g.picked.size || null, onclick: doImport }, `העלה ${g.picked.size} חשבוניות לתקופה`)) : null),
    section('חדשות', fresh, 'success', true),
    section('מוגנות בסיסמה', locked, 'warning', false, 'קובץ PDF עם סיסמה: יש לייבא אותו מהטלפון, ששומר את הסיסמאות ופותח אותן.'),
    section('קישורים שלא הצלחתי להוריד', linkOnly, 'warning', false, 'המייל מפנה להורדה באתר של הספק, והקובץ לא ירד אוטומטית. פתח את הקישור, הורד את החשבונית והעלה אותה בהעלאה מהמחשב.'),
    section('כבר ב-Drive', exists, 'neutral', false));
}

// --- files uploaded but not yet read by the phone, and reading them on the server -------------
state.pending = null;          // {files, readings: Map(fileId -> reading)}
state.reading = new Map();     // fileId -> 'busy' | error text

async function loadPending() {
  if (!state.token || !state.data) return;
  try {
    const known = new Set(state.data.documents().map((d) => d.drive_file_id));
    const files = (await driveList("appProperties has { key='app' and value='invoice-collector' } and trashed=false", 'id,name,mimeType,appProperties,createdTime'))
      .filter((f) => !known.has(f.id));
    const ids = new Set(files.map((f) => f.id));
    const sidecars = (await driveList("appProperties has { key='role' and value='reading' } and trashed=false", 'id,appProperties'))
      .filter((f) => ids.has(f.appProperties?.file));
    const readings = new Map(state.pending?.readings ?? []);
    await Promise.all(sidecars.filter((f) => !readings.has(f.appProperties.file)).map(async (f) => {
      try { readings.set(f.appProperties.file, await (await drive(`${DRIVE}/${f.id}?alt=media`)).json()); } catch { /* skip */ }
    }));
    state.pending = { files, readings };
    render();
  } catch (e) {
    console.warn('pending', e);
  }
}

const pendingIn = (folder) => (state.pending?.files ?? []).filter((f) => f.appProperties?.period === folder);

/** Periods that only exist in Drive so far (files uploaded for a new period). */
function newPendingPeriods(periods) {
  const known = new Set(periods.map((p) => p.folder_name));
  const extra = [...new Set((state.pending?.files ?? []).map((f) => f.appProperties?.period).filter((k) => k && !known.has(k)))];
  return extra.length ? h('div', { class: 'grid' }, extra.map((k) => h('a', { class: 'card link', href: `#/period/${k}` },
    h('div', { class: 'period-head' }, h('h2', {}, ltr(parsePeriod(k)?.label ?? k)), h('span', { class: 'muted' }, parsePeriod(k)?.year ?? '')),
    h('div', { class: 'pills' }, pill(`${pendingIn(k).length} הועלו, ממתינות לטלפון`, 'info'))))) : null;
}

async function readPending(ids) {
  if (!CONFIG.reader || !state.token) return;
  const queue = ids.filter((id) => !state.pending?.readings.has(id) && state.reading.get(id) !== 'busy');
  queue.forEach((id) => state.reading.set(id, 'busy'));
  render();
  const one = async (id) => {
    try {
      const r = await fetch(CONFIG.reader, { method: 'POST', headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: id }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `שגיאה ${r.status}`);
      state.pending?.readings.set(id, body);
      state.reading.delete(id);
    } catch (e) {
      state.reading.set(id, 'הקריאה נכשלה: ' + e.message);
    }
    render();
  };
  await Promise.all(Array.from({ length: 2 }, async () => { while (queue.length) await one(queue.shift()); }));
}

/** What the server read from a file, in one line; or its reading status. */
function readingLine(id) {
  const r = state.pending?.readings.get(id);
  const status = state.reading.get(id);
  if (!r) return status === 'busy' ? h('div', { class: 'muted' }, 'קורא עם Gemini…') : status ? h('div', { class: 'error' }, status) : null;
  const e = r.extraction ?? {};
  return h('div', { class: 'reading' },
    e.is_invoice === false ? pill('לא חשבונית מס', 'warning') : pill(DOC_TYPE[e.doc_type] ?? 'נקרא', 'success'),
    h('span', {}, [e.supplier_name, displayDate(e.invoice_date), e.total != null ? money(e.total) : null, e.description].filter(Boolean).join(' · ')));
}

function pendingCard(folder) {
  const files = pendingIn(folder);
  if (!files.length) return null;
  const unread = files.filter((f) => !state.pending.readings.has(f.id) && state.reading.get(f.id) !== 'busy');
  return h('section', { class: 'card' },
    h('div', { class: 'period-head' }, h('h2', {}, 'הועלו וממתינות לטלפון'), pill(String(files.length), 'info')),
    h('p', { class: 'note' }, 'הקבצים כבר ב-Drive. הקריאה כאן מוצגת מיד, והטלפון ישתמש בה כשהאפליקציה תיפתח (בלי לקרוא שוב). אישור של חשבונית לבדיקה נעשה בטלפון.'),
    unread.length && CONFIG.reader ? h('div', { class: 'toolbar' }, h('button', { class: 'button tonal', onclick: () => readPending(unread.map((f) => f.id)) }, `קרא עכשיו (${unread.length})`)) : null,
    files.map((f) => h('div', { class: 'row' },
      h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, ltr(f.name)), readingLine(f.id)),
      h('a', { class: 'text', href: `https://drive.google.com/file/d/${f.id}/view`, target: '_blank', rel: 'noopener' }, 'פתח ↗'))));
}

// --- router ---------------------------------------------------------------------------------
function render() {
  if (!state.data) { show(welcome()); return; }
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  let view;
  try {
    if (parts[0] === 'period') view = periodView(parts[1]);
    else if (parts[0] === 'doc') view = docView(+parts[1]);
    else if (parts[0] === 'card') view = cardView(parts[1]);
    else if (parts[0] === 'gmail') view = gmailView(new URLSearchParams(query ?? '').get('period'));
    else if (parts[0] === 'upload') view = uploadView(new URLSearchParams(query ?? '').get('period'));
    else if (parts[0] === 'products') view = productsView(new URLSearchParams(query ?? '').get('q') ?? '');
    else if (parts[0] === 'supplier') view = supplierView(+parts[1]);
    else if (parts[0] === 'product') view = productView(+parts[1], decodeURIComponent(parts.slice(2).join('/')));
    else view = homeView();
  } catch (e) {
    console.error(e);
    view = errorView('שגיאה בהצגת הדף: ' + e.message);
  }
  show(...[view].flat().filter(Boolean));
  watchHead();
}

// The sticky file preview sits under the header, whatever its height.
let headObserver;
function watchHead() {
  const head = document.querySelector('.head');
  headObserver?.disconnect();
  if (!head) return;
  headObserver = new ResizeObserver(() => document.documentElement.style.setProperty('--head', head.offsetHeight + 'px'));
  headObserver.observe(head);
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
// Local testing only: http://localhost:<port>/?dev opens a copy of the database next to the page.
if (['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('dev')) {
  // The copy's own time (not "now"), so an old copy doesn't look up to date.
  fetch('dev.db', { cache: 'no-store' }).then(async (r) => {
    const time = new Date(r.headers.get('Last-Modified') ?? Date.now()).toISOString();
    await open(new Uint8Array(await r.arrayBuffer()), 'dev', time);
  });
} else {
  start();
}

async function start() {
  state.token = savedToken();
  if (state.token) { loadFromDrive(); return; }
  const last = localGet(SIGNED_IN_KEY) === '1' ? await cache.get() : null;
  if (last) await open(last.bytes, 'cache', last.time);
  else render();
}
