// Importing invoices from Gmail, ported from the Android code (gmail/GmailSearch.kt,
// gmail/GmailClient.kt, gmail/InvoiceLinks.kt, imports/ImportPreparer.prepareFromGmail): the same
// search, the same filters, and links to invoices downloaded through the server function.

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MIN_IMAGE_BYTES = 20 * 1024; // smaller images are logos and signature icons
const EXCLUDED_WORDS = ['תעודת משלוח', 'delivery note', 'הצעת מחיר', 'quote', 'הזמנה', 'order confirmation'];
const TAX_WORDS = ['חשבונית', 'invoice'];
const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
const has = (s, w) => String(s ?? '').toLowerCase().includes(w.toLowerCase());

// --- GmailSearch.kt ---
/** Emails received in the period's months that mention an invoice (with or without a file). */
export function query(period) {
  const d = (y, m) => `${y}/${String(m).padStart(2, '0')}/01`;
  const endY = period.end === 12 ? period.year + 1 : period.year, endM = period.end === 12 ? 1 : period.end + 1;
  return `{חשבונית invoice} after:${d(period.year, period.start)} before:${d(endY, endM)} -from:me -in:sent -in:drafts`;
}

// --- core/Files.kt ---
const extension = (name) => (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase();
export const isInvoiceCandidate = (name) => !/^STK-/i.test(name) && (extension(name) === 'pdf' || extension(name) in IMAGE_TYPES);
export const mimeType = (name) => (extension(name) === 'pdf' ? 'application/pdf' : IMAGE_TYPES[extension(name)] ?? 'application/octet-stream');
export const isEncrypted = (name, bytes) => extension(name) === 'pdf' && new TextDecoder('latin1').decode(bytes).includes('/Encrypt');

// --- GmailClient.kt ---
const b64url = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export function client(token) {
  const get = async (path) => {
    const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  return {
    async search(q, limit = 300) {
      const ids = [];
      let page = '';
      do {
        const r = await get(`/messages?q=${encodeURIComponent(q)}&maxResults=100${page ? '&pageToken=' + page : ''}`);
        ids.push(...(r.messages ?? []).map((m) => m.id));
        page = r.nextPageToken ?? '';
      } while (page && ids.length < limit);
      return ids.slice(0, limit);
    },
    async message(id) {
      const o = await get(`/messages/${id}?format=full`);
      const headers = o.payload?.headers ?? [];
      const header = (n) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? '';
      const attachments = [], bodies = [];
      const walk = (part) => {
        if (part.filename && part.body?.attachmentId) {
          attachments.push({ messageId: id, attachmentId: part.body.attachmentId, fileName: part.filename, mimeType: part.mimeType, size: part.body.size ?? 0 });
        }
        if ((part.mimeType === 'text/html' || part.mimeType === 'text/plain') && part.body?.data && !part.filename) {
          try { bodies.push([part.mimeType, new TextDecoder().decode(b64url(part.body.data))]); } catch { /* skip */ }
        }
        (part.parts ?? []).forEach(walk);
      };
      walk(o.payload ?? {});
      return {
        id, receivedAt: +o.internalDate || 0, subject: header('Subject'), from: header('From'), attachments,
        body: (bodies.find((b) => b[0] === 'text/html') ?? bodies[0])?.[1] ?? '',
      };
    },
    async download(a) {
      return b64url((await get(`/messages/${a.messageId}/attachments/${a.attachmentId}`)).data);
    },
  };
}

// --- InvoiceLinks.kt: links that may lead to the invoice, most likely first ---
const GOOD = ['חשבונית', 'invoice', 'הורד', 'להורדה', 'download', 'pdf', 'לצפייה', 'צפייה', 'צפה', 'מסמך', 'document', 'קבלה', 'receipt'];
const BAD = ['unsubscribe', 'הסר', 'הסרה', 'privacy', 'פרטיות', 'facebook.', 'instagram.', 'linkedin.', 'twitter.', 'x.com/',
  'youtube.', 'whatsapp', 'wa.me', 'play.google', 'apps.apple', 'tiktok', 'mailto:', 'tel:', '/logo', '.png', '.jpg', '.gif',
  'google.com/maps', 'waze.com', 'תקנון', 'terms'];
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

export function candidates(body, limit = 3) {
  const anchors = [...body.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ url: decode(m[1]).trim(), text: decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() }));
  const bare = [...body.replace(/<[^>]+>/g, ' ').matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => ({ url: decode(m[0]).replace(/[.,)]+$/, ''), text: '' }));
  const seen = new Set();
  const all = [...anchors, ...bare].filter((l) => /^http/i.test(l.url) && !seen.has(l.url) && seen.add(l.url));
  const score = (l) => (GOOD.some((w) => has(l.text, w)) ? 2 : 0) + (GOOD.some((w) => has(l.url, w)) ? 1 : 0) + (/\.pdf$/i.test(l.url.split('?')[0]) ? 3 : 0);
  return all.filter((l) => !BAD.some((b) => has(l.url, b) || has(l.text, b)))
    .map((l) => [l, score(l)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([l]) => l);
}

// --- ImportPreparer.prepareFromGmail ---
const looksExcluded = (text) => EXCLUDED_WORDS.some((w) => has(text, w)) && !TAX_WORDS.some((w) => has(text, w));

/**
 * The period's invoices in Gmail: [{name, type, bytes, subject, from, received, locked, link, linkOnly}].
 * fetchLink(links) downloads an invoice from links (the server function) or returns null.
 * onProgress(done, total) while reading the emails.
 */
export async function findInvoices(token, period, fetchLink, onProgress) {
  const gmail = client(token);
  const ids = await gmail.search(query(period));
  const items = [];
  let done = 0, ignored = 0;
  onProgress?.(0, ids.length);
  const work = async (id) => {
    const m = await gmail.message(id);
    const found = [];
    for (const a of m.attachments) {
      const text = a.fileName + ' ' + m.subject;
      const tinyImage = extension(a.fileName) !== 'pdf' && a.size < MIN_IMAGE_BYTES;
      if (!isInvoiceCandidate(a.fileName) || a.size > MAX_ATTACHMENT_BYTES || tinyImage || looksExcluded(text)) { ignored++; continue; }
      const bytes = await gmail.download(a);
      found.push({ name: a.fileName, type: mimeType(a.fileName), bytes, locked: isEncrypted(a.fileName, bytes) });
    }
    // No invoice file attached: the invoice may be a download link in the email.
    if (!found.length && !looksExcluded(m.subject)) {
      const links = candidates(m.body);
      if (links.length) {
        const file = await fetchLink(links.map((l) => l.url)).catch(() => null);
        found.push(file ? { name: file.name, type: file.mimeType, bytes: b64url(file.data.replace(/\+/g, '-').replace(/\//g, '_')), locked: false, link: file.link }
          : { name: m.subject || 'חשבונית', linkOnly: true, link: links[0].url });
      }
    }
    for (const f of found) items.push({ ...f, subject: m.subject, from: m.from, received: m.receivedAt, emailId: m.id });
    onProgress?.(++done, ids.length);
  };
  // A few emails at a time.
  const queue = [...ids];
  await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await work(queue.shift()); }));
  return { items: items.sort((a, b) => a.received - b.received), ignored };
}
