// The credit card check, ported from the Android code (core/CardStatement.kt, core/CardMatcher.kt)
// so the web shows the same result: card charges against invoices, suppliers on account checked
// by the invoices that add up to each payment. Pure functions, no DOM.
import { normalizeName, normalizeTaxId, parseEntry, sameName } from './logic.js?v=15';

const DAY = 86400000;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY); // b - a, ISO dates

// --- CardStatement.kt ---
const DATE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/;
function parseDate(text) {
  const m = DATE.exec(String(text ?? '').trim());
  if (!m) return null;
  const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  const d = new Date(Date.UTC(y, +m[2] - 1, +m[1]));
  if (d.getUTCMonth() !== +m[2] - 1) return null;
  return d.toISOString().slice(0, 10);
}
export function parseAmount(text) {
  const s = String(text ?? '').replace(/[₪$€,‎‏]/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function headerColumns(cells) {
  const map = {};
  cells.forEach((raw, i) => {
    const h = raw.replace(/\n/g, ' ');
    if (h.startsWith('תאריך') && map.date == null) map.date = i;
    else if (h.includes('בית עסק') || h.includes('בית העסק')) map.merchant = i;
    else if (h.startsWith('סכום עסקה') || h === 'סכום העסקה') map.amount = i;
    else if (h.startsWith('מטבע עסקה')) map.currency = i;
    else if (h.startsWith('סכום חיוב') || h === 'סכום החיוב') map.charge = i;
    else if (h.includes('שובר') || h.includes('אסמכתא')) map.voucher = i;
    else if (h.startsWith('פירוט')) map.details = i;
  });
  return map.date != null && map.merchant != null && (map.amount != null || map.charge != null) ? map : null;
}
/** rows: arrays of cell texts. Finds every header row and reads the transactions under it. */
export function parseStatement(rows) {
  const out = [];
  let c = null;
  for (const row of rows) {
    const cells = row.map((x) => String(x ?? '').trim());
    const header = headerColumns(cells);
    if (header) { c = header; continue; }
    if (!c) continue;
    const cell = (k) => (c[k] != null ? cells[c[k]] ?? '' : '');
    if (cells.some((x) => x.startsWith('סה"כ') || x.startsWith('סה״כ'))) { c = null; continue; }
    const date = parseDate(cell('date'));
    if (!date) continue;
    const charge = parseAmount(cell('charge')) ?? parseAmount(cell('amount'));
    if (charge == null) continue;
    out.push({
      date, merchant: cell('merchant').replace(/\s+/g, ' '), amount: charge,
      originalAmount: parseAmount(cell('amount')), originalCurrency: cell('currency') || null,
      voucher: cell('voucher') || null, details: cell('details').replace(/\n/g, ' · ') || null,
    });
  }
  return out;
}

// --- CardMatcher.kt ---
export const NO_INVOICE_WORDS = [
  'מס הכנסה', 'ביטוח לאומי', 'המוסד לביטוח', 'מכס ומע', 'מע"מ', 'רשות המסים', 'דמי כרטיס', 'עמלת', 'ריבית', 'מקדמות',
  // Foreign online shops: no Israeli tax invoice (owner, 2026-11-24).
  'amazon', 'אמזון', 'aliexpress', 'ali express', 'עלי אקספרס', 'אלי אקספרס',
];
const DAYS_BEFORE = 45, DAYS_AFTER = 15, ACCOUNT_DAYS_BEFORE = 180, MAX_COMBINED = 10;

export const needsNoInvoice = (t) => NO_INVOICE_WORDS.some((w) => t.merchant.toLowerCase().includes(w.toLowerCase()));
export const inPeriod = (date, p) => +date.slice(0, 4) === p.year && +date.slice(5, 7) >= p.start && +date.slice(5, 7) <= p.end;

/** Several statements together: a transaction listed twice counts once. */
export function merge(statements) {
  const seen = new Set();
  return statements.flat().filter((t) => {
    const k = t.voucher ? 'v:' + t.voucher : `${t.date}|${t.merchant}|${t.amount}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function nameScore(merchant, supplier) {
  if (!supplier) return 0;
  if (sameName(merchant, supplier)) return 2;
  const a = new Set(normalizeName(merchant).split(' ').filter((w) => w.length >= 3));
  return normalizeName(supplier).split(' ').some((w) => w.length >= 3 && a.has(w)) ? 1 : 0;
}

/** An on-account supplier: every invoice of the supplier its entries name, whatever group it is in. */
export function account(group) {
  const entries = [...group.taxIds, ...group.matchers].map(parseEntry).filter((e) => e.key);
  return {
    groupId: group.id, title: group.title,
    namesMerchant: (merchant) => entries.filter((e) => !e.isTaxId).some((e) =>
      sameName(e.key, merchant) || normalizeName(merchant).includes(normalizeName(e.key))),
    owns: (inv) => inv.groupId === group.id || entries.some((e) => {
      if (e.isTaxId) {
        const t = normalizeTaxId(inv.supplierTaxId);
        return t != null && normalizeTaxId(e.key) === t;
      }
      const key = normalizeName(e.key);
      return !!inv.supplierName && key.length > 0 && (normalizeName(inv.supplierName).includes(key) || sameName(e.key, inv.supplierName));
    }),
  };
}

/** Two or more invoices whose totals add up to target (agorot); the fewest wins. */
function subsetSum(group, target) {
  const items = [...group].sort((a, b) => b.total - a.total).slice(0, 20);
  const cents = items.map((i) => Math.round(i.total * 100));
  let best = null;
  const picked = [];
  const search = (start, sum) => {
    if (sum === target && picked.length >= 2) { if (!best || picked.length < best.length) best = [...picked]; return; }
    if (sum >= target || picked.length >= MAX_COMBINED || (best && picked.length + 1 >= best.length)) return;
    for (let k = start; k < items.length; k++) {
      if (sum + cents[k] > target) continue;
      picked.push(k);
      search(k + 1, sum + cents[k]);
      picked.pop();
    }
  };
  search(0, 0);
  return best ? best.map((k) => items[k]).sort((a, b) => a.date.localeCompare(b.date)) : null;
}
const subsetSumOrSingle = (group, target) => {
  const one = group.find((i) => i.total != null && Math.round(i.total * 100) === target);
  return one ? [one] : subsetSum(group, target);
};

/**
 * transactions: from parseStatement / merge. invoices: {documentId, supplierName, supplierTaxId,
 * date, total, groupId, description, folder}. period: {year, start, end} or null. accounts: from account().
 * Returns {results: [{transaction, outcome, invoice}], accounts: [balance]}.
 */
export function matchAll(transactions, invoices, period, accounts) {
  const accountOf = (merchant) => accounts.find((a) => a.namesMerchant(merchant) || invoices.some((i) => a.owns(i) && nameScore(merchant, i.supplierName) > 0));
  const accountOfTx = new Map(transactions.map((t) => [t, accountOf(t.merchant)]));

  const balances = accounts.flatMap((a) => {
    const payments = transactions.filter((t) => accountOfTx.get(t) === a && (!period || inPeriod(t.date, period))).sort((x, y) => x.date.localeCompare(y.date));
    if (!payments.length) return [];
    const paymentsFrom = period ? `${period.year}-${String(period.start).padStart(2, '0')}-01` : payments[0].date;
    const to = period ? new Date(Date.UTC(period.year, period.end, 0)).toISOString().slice(0, 10) : payments[payments.length - 1].date;
    const invoicesFrom = new Date(Date.parse(paymentsFrom) - ACCOUNT_DAYS_BEFORE * DAY).toISOString().slice(0, 10);
    const own = invoices.filter((i) => a.owns(i) && i.date && i.total != null && i.date >= invoicesFrom && i.date <= to).sort((x, y) => x.date.localeCompare(y.date));
    const free = [...own];
    const hints = new Map();
    for (const p of payments) {
      const limit = new Date(Date.parse(p.date) + DAYS_AFTER * DAY).toISOString().slice(0, 10);
      const found = subsetSumOrSingle(free.filter((i) => i.date <= limit), Math.round(p.amount * 100));
      if (found) { hints.set(p, found); found.forEach((i) => free.splice(free.indexOf(i), 1)); }
    }
    return [{ account: a, payments, invoices: own, hints, unassigned: free }];
  });

  const singles = invoices.filter((i) => !accounts.some((a) => a.owns(i)));
  const used = new Set();
  const order = transactions.map((_, i) => i).sort((x, y) => Math.abs(transactions[y].amount) - Math.abs(transactions[x].amount));
  const results = new Array(transactions.length);
  for (const i of order) {
    const t = transactions[i];
    if (period && !inPeriod(t.date, period)) { results[i] = { transaction: t, outcome: 'outside' }; continue; }
    if (accountOfTx.get(t)) { results[i] = { transaction: t, outcome: 'on_account' }; continue; }
    if (needsNoInvoice(t)) { results[i] = { transaction: t, outcome: 'no_invoice' }; continue; }
    const candidates = singles.filter((inv) => !used.has(inv.documentId) && inv.total != null && Math.abs(inv.total - t.amount) < 0.05
      && (!inv.date || (days(t.date, inv.date) >= -DAYS_BEFORE && days(t.date, inv.date) <= DAYS_AFTER)));
    candidates.sort((a, b) => nameScore(t.merchant, b.supplierName) - nameScore(t.merchant, a.supplierName)
      || (a.date ? Math.abs(days(t.date, a.date)) : 99) - (b.date ? Math.abs(days(t.date, b.date)) : 99));
    const best = candidates[0];
    if (best) { used.add(best.documentId); results[i] = { transaction: t, outcome: 'matched', invoice: best }; }
    else results[i] = { transaction: t, outcome: 'missing' };
  }
  return { results, accounts: balances };
}
