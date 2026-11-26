// Reads the app's database (the phone's Drive backup, opened with sql.js) into plain objects.
import { EXCLUDED, PRODUCTS, beforeVat, buildCatalog, checklist, groupFor, linesIncludeVat, parsePeriod, vatRateFor } from './logic.js?v=17';

const SEPARATOR = '\n';

function rows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function columns(db, table) {
  return new Set(rows(db, `PRAGMA table_info(${table})`).map((r) => r.name));
}

export class Data {
  constructor(db) {
    this.db = db;
    this.invoiceCols = columns(db, 'invoices');
    this.groupCols = columns(db, 'recurring_items');
    this.hasNotes = rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_notes'").length > 0;
    this.groups = this.loadGroups();
  }

  col(name, fallback = 'NULL') {
    return this.invoiceCols.has(name) ? `i.${name}` : fallback;
  }

  loadGroups() {
    const g = this.groupCols;
    const extra = [g.has('on_account') ? 'on_account' : '0 AS on_account', g.has('delivery_note_lines') ? 'delivery_note_lines' : '0 AS delivery_note_lines'];
    return rows(this.db, `SELECT id, title, expected_count, matchers, tax_ids, kind, ${extra.join(', ')} FROM recurring_items ORDER BY sort, id`).map((r) => ({
      id: r.id, title: r.title, expectedPerPeriod: r.expected_count, kind: r.kind,
      matchers: String(r.matchers ?? '').split(SEPARATOR).filter((s) => s.trim()),
      taxIds: String(r.tax_ids ?? '').split(SEPARATOR).filter((s) => s.trim()),
      onAccount: !!r.on_account, deliveryNoteLines: !!r.delivery_note_lines,
    }));
  }

  /** Every document with its reading, for one period or all. */
  documents(periodId = null) {
    const where = periodId == null ? '' : 'WHERE d.period_id = ?';
    return rows(this.db, `
      SELECT d.id, d.period_id, d.drive_file_id, d.file_name, d.mime_type, d.status, d.error, p.folder_name,
             i.id AS invoice_id, i.doc_type, i.invoice_number, i.invoice_date, i.amount_before_vat, i.vat_amount, i.total,
             i.issues, i.confirmed_at, i.raw_extraction, s.name AS supplier_name, s.tax_id AS supplier_tax_id,
             ${this.col('billing_start')} AS billing_start, ${this.col('billing_end')} AS billing_end,
             ${this.col('description')} AS description, ${this.col('group_id')} AS group_id
      FROM documents d JOIN periods p ON p.id = d.period_id
      LEFT JOIN invoices i ON i.document_id = d.id LEFT JOIN suppliers s ON s.id = i.supplier_id
      ${where} ORDER BY d.file_name`, periodId == null ? [] : [periodId]).map((r) => {
      const ref = { supplierName: r.supplier_name, supplierTaxId: r.supplier_tax_id, description: r.description, groupId: r.group_id, id: r.id,
        outsidePeriod: String(r.issues ?? '').includes('date_outside_period') };
      const group = r.invoice_id != null ? groupFor(this.groups, ref) : null;
      return { ...r, ref, group, issues: String(r.issues ?? '').split(',').filter(Boolean) };
    });
  }

  /** Periods, newest first, with totals and what needs attention. */
  periods() {
    const docs = this.documents();
    return rows(this.db, 'SELECT id, folder_name, drive_folder_id, summary_sheet_id FROM periods').map((p) => {
      const mine = docs.filter((d) => d.period_id === p.id);
      const invoices = mine.filter((d) => d.invoice_id != null && !EXCLUDED.includes(d.status));
      const fixed = checklist(this.groups, mine.filter((d) => d.invoice_id != null && !['not_invoice', 'duplicate', 'failed'].includes(d.status)).map((d) => d.ref));
      return {
        ...p, period: parsePeriod(p.folder_name), documents: mine,
        count: invoices.length,
        total: invoices.reduce((s, d) => s + (d.total ?? 0), 0),
        beforeVat: invoices.reduce((s, d) => s + (d.amount_before_vat ?? 0), 0),
        vat: invoices.reduce((s, d) => s + (d.vat_amount ?? 0), 0),
        review: mine.filter((d) => d.status === 'needs_review' || d.status === 'failed').length,
        pending: mine.filter((d) => d.status === 'pending').length,
        unassigned: invoices.filter((d) => !d.group).length,
        checklist: fixed,
        missingFixed: fixed.reduce((s, c) => s + c.missing, 0),
      };
    }).sort((a, b) => b.folder_name.localeCompare(a.folder_name));
  }

  /** Content hashes of every file the app ever took in (duplicates and non-invoices too). */
  knownHashes() {
    return new Set(rows(this.db, 'SELECT sha256 FROM documents WHERE sha256 IS NOT NULL').map((r) => r.sha256));
  }

  document(id) {
    const d = rows(this.db, 'SELECT period_id FROM documents WHERE id = ?', [id])[0];
    if (!d) return null;
    const doc = this.documents(d.period_id).find((x) => x.id === id);
    if (doc?.invoice_id != null) {
      doc.lines = rows(this.db, `SELECT line_no, description, sku, quantity, unit, unit_price_before_vat, line_total_before_vat, kind
                                FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no`, [doc.invoice_id]);
    }
    return doc;
  }

  /** Product suppliers with products, purchases and invoices (as on the phone's second tab). */
  catalog() {
    if (this._catalog) return this._catalog;
    const lines = [];
    const invoices = [];
    const lineRows = rows(this.db, `
      SELECT d.id, s.name, s.tax_id, ${this.col('description')} AS idesc, ${this.col('group_id')} AS gid, i.invoice_date, i.invoice_number,
             l.description, l.sku, l.quantity, l.unit_price_before_vat, l.line_total_before_vat
      FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id JOIN documents d ON d.id = i.document_id
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE l.kind = 'product' AND d.status NOT IN ('not_invoice', 'duplicate', 'failed', 'pending')`);
    for (const r of lineRows) {
      const g = groupFor(this.groups, { supplierName: r.name, supplierTaxId: r.tax_id, description: r.idesc, groupId: r.gid });
      if (g?.kind !== PRODUCTS) continue;
      lines.push({
        groupId: g.id, groupTitle: g.title, documentId: r.id, invoiceDate: r.invoice_date, invoiceNumber: r.invoice_number,
        description: r.description, sku: r.sku, quantity: r.quantity, unitPrice: r.unit_price_before_vat, lineTotal: r.line_total_before_vat,
      });
    }
    for (const d of this.documents()) {
      if (d.invoice_id == null || EXCLUDED.includes(d.status) || d.group?.kind !== PRODUCTS) continue;
      invoices.push({
        groupId: d.group.id, groupTitle: d.group.title, documentId: d.id, date: d.invoice_date, number: d.invoice_number,
        amountBeforeVat: d.amount_before_vat, total: d.total,
      });
    }
    // Order emails whose tax invoice isn't in the app: their prices and quantities count in the
    // product's history (marked), their amounts don't (as on the phone).
    if (this.hasNotes) {
      for (const g of this.groups.filter((x) => x.deliveryNoteLines && x.kind === PRODUCTS)) {
        for (const n of rows(this.db, `SELECT id, sha256, raw_extraction, note_date, email_date FROM delivery_notes
             WHERE group_id = ? AND status = 'read' AND invoice_id IS NULL AND sha256 LIKE 'order:%' AND total > 0`, [g.id])) {
          let e;
          try { e = JSON.parse(n.raw_extraction); } catch { continue; }
          const date = n.note_date ?? n.email_date, rate = vatRateFor(date);
          const incl = linesIncludeVat(e) ?? !!e.line_prices_include_vat;
          for (const l of (e.lines ?? []).filter((x) => x.kind === 'product' && x.description?.trim())) {
            lines.push({ groupId: g.id, groupTitle: g.title, documentId: -n.id, invoiceDate: date, invoiceNumber: null, description: l.description,
              sku: l.sku, quantity: l.quantity, unitPrice: beforeVat(l.unit_price, incl, rate), lineTotal: beforeVat(l.line_total, incl, rate),
              orderNumber: n.sha256.split(':').pop() });
          }
        }
      }
    }
    const catalog = buildCatalog(lines, invoices);
    for (const s of catalog) s.notes = this.noteStats(s.groupId);
    return (this._catalog = catalog);
  }

  noteStats(groupId) {
    const group = this.groups.find((g) => g.id === groupId);
    if (!this.hasNotes || !group?.deliveryNoteLines) return null;
    const r = rows(this.db, `SELECT SUM(status = 'read') AS read, SUM(status = 'pending') AS pending,
                             COUNT(DISTINCT invoice_id) AS matched FROM delivery_notes WHERE group_id = ?`, [groupId])[0];
    return { notes: r.read ?? 0, pending: r.pending ?? 0, matchedInvoices: r.matched ?? 0 };
  }
}
