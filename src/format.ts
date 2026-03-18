export type Format = 'table' | 'json' | 'csv' | 'raw';

export function detectFormat(explicit?: string): Format {
  if (explicit) return explicit as Format;
  return process.stdout.isTTY ? 'table' : 'csv';
}

export function formatRows(rows: Record<string, unknown>[], format: Format, meta?: { rowCount?: number; executionTimeMs?: number; executionTime?: number }): string {
  if (rows.length === 0) return format === 'json' ? '[]' : '0 rows';

  switch (format) {
    case 'json':
      return JSON.stringify(rows, null, 2);
    case 'csv':
      return formatCsv(rows);
    case 'raw':
      return JSON.stringify({ success: true, data: rows, meta }, null, 2);
    case 'table':
    default:
      return formatTable(rows, meta);
  }
}

function formatCsv(rows: Record<string, unknown>[]): string {
  const keys = Object.keys(rows[0]);
  const lines = [keys.join(',')];
  for (const row of rows) {
    lines.push(keys.map(k => csvEscape(row[k])).join(','));
  }
  return lines.join('\n');
}

function csvEscape(val: unknown): string {
  const s = val == null ? '' : String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function formatTable(rows: Record<string, unknown>[], meta?: { rowCount?: number; executionTimeMs?: number; executionTime?: number }): string {
  const keys = Object.keys(rows[0]);
  const widths = keys.map(k => k.length);

  const stringRows = rows.map(row =>
    keys.map((k, i) => {
      const s = row[k] == null ? '' : String(row[k]);
      widths[i] = Math.max(widths[i], s.length);
      return s;
    })
  );

  const sep = (left: string, mid: string, right: string, fill: string) =>
    left + widths.map(w => fill.repeat(w + 2)).join(mid) + right;

  const pad = (vals: string[]) =>
    '│ ' + vals.map((v, i) => v.padEnd(widths[i])).join(' │ ') + ' │';

  const lines: string[] = [];
  lines.push(sep('┌', '┬', '┐', '─'));
  lines.push(pad(keys));
  lines.push(sep('├', '┼', '┤', '─'));
  for (const row of stringRows) lines.push(pad(row));
  lines.push(sep('└', '┴', '┘', '─'));

  const count = meta?.rowCount ?? rows.length;
  const ms = meta?.executionTimeMs ?? meta?.executionTime;
  lines.push(`${count} row${count !== 1 ? 's' : ''}` + (ms != null ? ` (${Math.round(ms)}ms)` : ''));

  return lines.join('\n');
}
