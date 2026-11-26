// The desktop web view of the app: reads the phone's database backup from Google Drive (view
// only) and shows the periods, invoices and the suppliers & products dashboard.
import { CONFIG } from './config.js';
import { Data } from './data.js';
import { timeChart } from './charts.js';
import {
  ALL_KINDS, EXCLUDED, FIXED, OCCASIONAL, PRODUCTS, RUNNING, cumulative, displayDate, displayPeriod, parsePeriod,
  quantityByMonth, sameDayTogether, withVat,
} from './logic.js';

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
let tokenClient;
function signIn() {
  if (!CONFIG.clientId) { show(errorView('חסר מזהה OAuth לאתר (config.js). אפשר בינתיים לפתוח קובץ גיבוי מהמחשב.')); return; }
  tokenClient ??= google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.clientId, scope: SCOPE,
    callback: (resp) => {
      if (resp.error) { show(errorView('ההתחברות נכשלה: ' + resp.error)); return; }
      state.token = resp.access_token;
      loadFromDrive();
    },
  });
  tokenClient.requestAccessToken();
}

async function drive(url) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + state.token } });
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
    await open(bytes, 'drive', file.modifiedTime);
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
    h('button', { class: 'primary', onclick: signIn }, 'התחבר עם Google'),
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
    h('nav', {}, h('a', { href: '#/', class: active === 'invoices' ? 'on' : '' }, 'חשבוניות'), h('a', { href: '#/products', class: active === 'products' ? 'on' : '' }, 'ספקים ומוצרים')),
    state.source === 'drive' ? h('button', { class: 'text', onclick: loadFromDrive, title: 'טען שוב את הגיבוי' }, 'רענן') : null);
}

function page(active, title, subtitle, sticky, ...body) {
  return [h('div', { class: 'head' }, topBar(active), sticky ? h('div', { class: 'sticky' }, sticky) : null),
    h('main', {}, title ? h('div', { class: 'title' }, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null) : null, ...body)];
}

// Home: the periods.
function homeView() {
  const periods = state.data.periods();
  return page('invoices', 'תקופות דיווח', null, null,
    h('div', { class: 'grid' }, periods.map((p) => h('a', { class: 'card link period', href: `#/period/${p.folder_name}` },
      h('div', { class: 'period-head' }, h('h2', {}, ltr(p.period?.label ?? p.folder_name)), h('span', { class: 'muted' }, p.period?.year ?? '')),
      h('div', { class: 'big' }, money(p.total)),
      h('div', { class: 'muted' }, `${p.count} חשבוניות`),
      h('div', { class: 'pills' },
        p.review ? pill(`${p.review} לבדיקה`, 'danger') : null,
        p.missingFixed ? pill(`${p.missingFixed} קבועות חסרות`, 'warning') : pill('הקבועות מלאות', 'success'),
        p.unassigned ? pill(`${p.unassigned} לא משויכות`, 'warning') : null,
        p.pending ? pill(`${p.pending} ממתינות`, 'info') : null)))));
}

// One period.
function periodView(folder) {
  const p = state.data.periods().find((x) => x.folder_name === folder);
  if (!p) return page('invoices', 'התקופה לא נמצאה', null, null);
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

// --- router ---------------------------------------------------------------------------------
function render() {
  if (!state.data) { show(welcome()); return; }
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  let view;
  try {
    if (parts[0] === 'period') view = periodView(parts[1]);
    else if (parts[0] === 'doc') view = docView(+parts[1]);
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
  render();
}
