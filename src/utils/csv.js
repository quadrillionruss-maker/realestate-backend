// csv.js — an RFC 4180 parser, in about sixty lines.
//
// Written rather than installed on purpose. This service has no dependency it
// does not need, and the entire surface used here is: quoted fields, embedded
// commas, embedded newlines, and escaped double quotes. A parser for that is
// smaller than the argument about which library to add.
//
// Two things it handles that a `split(',')` does not, and that real exports
// from Excel and Google Sheets contain constantly:
//   "Okonkwo, Adeyemi",08031234567      → one field, not two
//   "He said ""Friday""",5000000        → a literal double quote
//
// Also strips the UTF-8 BOM Excel writes at the front of every file it saves
// as CSV, which otherwise turns the first header into "﻿full_name" and
// makes column matching fail for reasons nobody can see.

function parseCsv(text) {
  const input = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        // "" inside a quoted field is one literal quote.
        if (input[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += char; i += 1; continue;
    }

    if (char === '"') { inQuotes = true; i += 1; continue; }

    if (char === ',') { row.push(field); field = ''; i += 1; continue; }

    if (char === '\r') { i += 1; continue; } // CRLF → LF
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }

    field += char; i += 1;
  }

  // A file that does not end in a newline still has a last row.
  if (field.length || row.length) { row.push(field); rows.push(row); }

  // Drop blank trailing lines, which every spreadsheet export has at least one of.
  return rows.filter((r) => r.some((cell) => String(cell).trim().length));
}

// Header row → objects. Headers are normalized so "Full Name", "full_name" and
// "FULL NAME" all land on the same key: a developer filling in a template
// should not have to match our capitalization.
const normalizeHeader = (header) =>
  String(header || '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');

function parseCsvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };

  const headers = rows[0].map(normalizeHeader);
  const records = rows.slice(1).map((row, index) => {
    const record = { __row: index + 2 }; // +2: 1-indexed, and the header is row 1
    headers.forEach((header, column) => {
      if (header) record[header] = String(row[column] ?? '').trim();
    });
    return record;
  });

  return { headers, records };
}

// "₦2,500,000.00" → 2500000. Developers paste amounts straight out of their
// own spreadsheets, currency symbol and thousands separators included.
function parseAmount(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).replace(/[₦$,\s]/g, '');
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

// Accepts the three date shapes a Nigerian spreadsheet actually contains:
// 2026-03-01, 01/03/2026 (day first — the local convention) and 1 March 2026.
function parseDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const slash = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(raw);
  if (slash) {
    const [, day, month, year] = slash;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

  return null;
}

module.exports = { parseCsv, parseCsvToObjects, parseAmount, parseDate, normalizeHeader };
