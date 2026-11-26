// The app's rules, ported from the Android code (core/*.kt) so the web shows the same thing:
// supplier names, expense groups (with description words and per-invoice choices), the fixed
// expenses checklist, VAT, dates and the product catalog. Pure functions, no DOM.

export const FIXED = 'fixed', PRODUCTS = 'products', RUNNING = 'running', OCCASIONAL = 'occasional';
export const ALL_KINDS = [FIXED, PRODUCTS, RUNNING, OCCASIONAL];
export const EXCLUDED = ['not_invoice', 'duplicate', 'failed', 'pending'];

// --- SupplierNames.kt ---
const SUFFIXES = ['בעמ', 'בע מ', 'ltd', 'בעמ.', 'inc'];
export function normalizeName(name) {
  let s = String(name).toLowerCase().replace(/["'״׳`.,()\-]/g, '').replace(/\s+/g, ' ').trim();
  for (const suffix of SUFFIXES) if (s.endsWith(' ' + suffix)) s = s.slice(0, -(suffix.length + 1)).trim();
  return s;
}
export function sameName(a, b) {
  const x = normalizeName(a), y = normalizeName(b);
  if (x.length < 3 || y.length < 3) return x === y;
  return x.includes(y) || y.includes(x);
}

// --- InvoiceRules.kt ---
export function normalizeTaxId(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits ? digits.padStart(9, '0') : null;
}
export const round2 = (n) => Math.round(n * 100) / 100;
export const vatRateFor = (date) => (date && date < '2025-01-01' ? 17 : 18);
export const withVat = (beforeVat, date) => round2(beforeVat * (1 + vatRateFor(date) / 100));

// --- RecurringInvoices.kt ---
export function parseEntry(raw) {
  const i = raw.indexOf('|');
  const key = (i < 0 ? raw : raw.slice(0, i)).trim();
  const words = i < 0 ? [] : raw.slice(i + 1).split(',').map((w) => w.trim()).filter(Boolean);
  return { key, words, isTaxId: key.length > 0 && /^\d+$/.test(key) };
}
const entries = (item) => [...item.taxIds, ...item.matchers].map(parseEntry);

function sameSupplier(e, inv) {
  if (e.isTaxId) {
    const t = normalizeTaxId(inv.supplierTaxId);
    return t != null && normalizeTaxId(e.key) === t;
  }
  if (!inv.supplierName || e.key.includes('@')) return false;
  const key = normalizeName(e.key);
  return key.length > 0 && (normalizeName(inv.supplierName).includes(key) || sameName(e.key, inv.supplierName));
}
const wordsOk = (e, inv) =>
  e.words.length === 0 || e.words.some((w) => (inv.description ?? '').toLowerCase().includes(w.toLowerCase()));

export function matchingEntry(item, inv) {
  return entries(item).find((e) => sameSupplier(e, inv) && wordsOk(e, inv)) ?? null;
}

/** The group of an invoice: the owner's choice for it, else the most specific matching entry. */
export function groupFor(items, inv) {
  if (inv.groupId != null) {
    const chosen = items.find((i) => i.id === inv.groupId);
    if (chosen) return chosen;
  }
  let best = null, bestScore = -1;
  for (const item of items) {
    const e = matchingEntry(item, inv);
    if (!e) continue;
    const score = (e.words.length ? 2 : 0) + (e.isTaxId ? 1 : 0);
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best;
}

/**
 * Fixed expenses of a period: how many invoices each has. Each invoice counts once; one dated
 * outside the period (an old bill kept in this report) is listed in outsideIds, not counted.
 */
export function checklist(items, invoices) {
  const owner = invoices.map((inv) => groupFor(items, inv));
  return items.filter((i) => i.kind === FIXED).map((item) => {
    const mine = invoices.filter((_, k) => owner[k] === item);
    const ids = mine.filter((inv) => !inv.outsidePeriod).map((inv) => inv.id);
    const outsideIds = mine.filter((inv) => inv.outsidePeriod).map((inv) => inv.id);
    const linked = item.matchers.length > 0 || item.taxIds.length > 0;
    const missing = Math.max(0, item.expectedPerPeriod - ids.length);
    return { item, found: ids.length, ids, outsideIds, linked, missing, complete: linked && missing === 0 };
  });
}

// --- Period.kt: folder "2026-11-12" = year 2026, months 11-12 ---
export function parsePeriod(folder) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(folder ?? '');
  if (!m) return null;
  return { year: +m[1], start: +m[2], end: +m[3], label: `${m[2]}-${m[3]}` };
}

// --- DisplayDates.kt ---
export function displayDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}
export function displayPeriod(start, end) {
  const s = /^(\d{4})-(\d{2})-(\d{2})/.exec(start ?? ''), e = /^(\d{4})-(\d{2})-(\d{2})/.exec(end ?? '');
  if (s && e) {
    const lastDay = new Date(+s[1], +s[2], 0).getDate();
    if (s[3] === '01' && e[1] === s[1] && e[2] === s[2] && +e[3] === lastDay) return `${s[2]}/${s[1]}`;
    if (s[1] === e[1]) return `${s[3]}/${s[2]}–${displayDate(end)}`;
    return `${displayDate(start)}–${displayDate(end)}`;
  }
  return displayDate(start) ?? displayDate(end);
}

// --- AnomalyReport.normalize + ProductCatalog.kt ---
export const normalizeProduct = (d) => String(d).toLowerCase().replace(/["'״׳`.,()\-/*]/g, ' ').replace(/\s+/g, ' ').trim();
export function productKey(description, sku) {
  const code = String(sku ?? '').replace(/[^\p{L}\p{N}]/gu, '');
  return code.length >= 3 ? 'sku:' + code : 'name:' + normalizeProduct(description);
}

/**
 * Suppliers (product groups) with their products and invoices.
 * rows: product lines {groupId, groupTitle, documentId, invoiceDate, invoiceNumber, description, sku, quantity, unitPrice, lineTotal}
 * invoices: {groupId, groupTitle, documentId, date, number, amountBeforeVat, total}
 */
export function buildCatalog(rows, invoices) {
  const byGroup = new Map();
  const groupOf = (id, title) => {
    if (!byGroup.has(id)) byGroup.set(id, { groupId: id, title, products: [], invoices: [] });
    return byGroup.get(id);
  };
  for (const inv of invoices) groupOf(inv.groupId, inv.groupTitle).invoices.push(inv);
  const lines = new Map();
  for (const r of rows) {
    groupOf(r.groupId, r.groupTitle);
    const k = r.groupId + '\u0000' + productKey(r.description, r.sku);
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k).push(r);
  }
  for (const [k, list] of lines) {
    list.sort((a, b) => (a.invoiceDate ?? '').localeCompare(b.invoiceDate ?? '') || a.documentId - b.documentId);
    const last = list[list.length - 1];
    const purchases = list.map((r) => ({
      date: r.invoiceDate, quantity: r.quantity, unitPrice: r.unitPrice, documentId: r.documentId, invoiceNumber: r.invoiceNumber,
      amount: r.lineTotal ?? (r.quantity != null && r.unitPrice != null ? round2(r.quantity * r.unitPrice) : null),
    }));
    const priced = purchases.filter((p) => p.unitPrice != null);
    const before = priced.length >= 2 ? priced[priced.length - 2].unitPrice : null;
    const lastPrice = priced.length ? priced[priced.length - 1].unitPrice : null;
    byGroup.get(last.groupId).products.push({
      key: k.split('\u0000')[1],
      name: last.description.trim(),
      sku: [...list].reverse().find((r) => r.sku)?.sku ?? null,
      purchases,
      lastPrice,
      lastDate: purchases[purchases.length - 1].date,
      totalQuantity: purchases.reduce((s, p) => s + (p.quantity ?? 0), 0),
      purchaseCount: new Set(purchases.map((p) => p.documentId)).size,
      lastChangePercent: before ? ((lastPrice - before) / before) * 100 : null,
    });
  }
  const out = [...byGroup.values()];
  for (const s of out) {
    s.invoices.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.documentId - b.documentId);
    s.products.sort((a, b) => b.purchaseCount - a.purchaseCount || a.name.localeCompare(b.name, 'he'));
    s.totalBeforeVat = s.invoices.reduce((t, i) => t + (i.amountBeforeVat ?? 0), 0);
    s.totalWithVat = s.invoices.reduce((t, i) => t + (i.total ?? 0), 0);
    const dates = [...s.invoices.map((i) => i.date), ...s.products.map((p) => p.lastDate)].filter(Boolean).sort();
    s.firstPurchase = s.invoices.map((i) => i.date).filter(Boolean).sort()[0] ?? null;
    s.lastPurchase = dates[dates.length - 1] ?? null;
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'he'));
}

/** Quantity per month ("YYYY-MM"), oldest first. */
export function quantityByMonth(product) {
  const m = new Map();
  for (const p of product.purchases) {
    if (!p.date || p.date.length < 7) continue;
    const k = p.date.slice(0, 7);
    m.set(k, (m.get(k) ?? 0) + (p.quantity ?? 0));
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Points on the same day become one (values added up). */
export function sameDayTogether(points, detail) {
  const m = new Map();
  for (const p of points) {
    if (!m.has(p.date)) m.set(p.date, []);
    m.get(p.date).push(p);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, list]) => ({
    date, value: list.reduce((s, p) => s + p.value, 0), detail: list.length > 1 ? detail(list.length) : list[0].detail,
  }));
}

export function cumulative(values) {
  let sum = 0;
  return values.map((v) => (sum = round2(sum + v)));
}
