import { Injectable } from '@nestjs/common';

/** A column: text cells (names people typed) are neutralised against formula injection; formatted cells (numbers, money, dates) are the server's own output. */
export interface CsvColumn {
  name: string;
  kind: 'text' | 'formatted';
}

/** A cell value; null is an empty cell. */
export type CsvCell = string | number | null;

// A cell that a spreadsheet would read as a formula (OWASP CSV injection).
const FORMULA_START = /^[=+\-@\t\r]/;
// A cell that must be quoted (RFC 4180).
const NEEDS_QUOTES = /[",\r\n]/;

// The CSV exports (Phase G1e, docs/phase-g1-design.md section 5): UTF-8 with a
// byte-order mark (so spreadsheets read the names right), a header row, CRLF
// line endings and RFC 4180 quoting. Text cells (names people typed) that
// start with =, +, -, @, a tab or a carriage return get a leading apostrophe,
// so a spreadsheet shows them as text instead of running them. Formatted cells (numbers, money,
// dates) are left alone: an apostrophe would turn -1 or -10.00 into text and break
// sums. The file is built once from rows read once.
@Injectable()
export class CsvWriter {
  write(columns: CsvColumn[], rows: CsvCell[][]): string {
    const lines = [columns.map((c) => quote(c.name)).join(',')];
    for (const row of rows) {
      lines.push(row.map((cell, i) => (cell === null ? '' : quote(columns[i].kind === 'text' ? neutralise(String(cell)) : String(cell)))).join(','));
    }
    return `﻿${lines.join('\r\n')}\r\n`;
  }
}

function neutralise(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function quote(text: string): string {
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
