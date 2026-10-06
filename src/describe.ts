import type { SchemaVersion } from './client.js';

/**
 * PAY-2052: `vsql describe <table>` from the Vibe-native schema (GET /v1/schemas), not information_schema.
 * The raw SQL route is platform-admin-only on the hosted API, so describe 403'd for every tenant key.
 *
 * A table entry in the active schema is { type:'object', required:[...], properties:{ col:{ type, format?,
 * 'x-vibe-pk'?, 'x-vibe-auto-increment'? } } }. There is no column default and no ordinal; properties come in
 * schema order, and nullable means "not in required".
 */
export type DescribeRow = { column_name: string; type: string; format: string; pk: string; auto_increment: string; nullable: string };

export type DescribeFailure = { code: 'COLLECTION_NOT_FOUND' | 'TABLE_NOT_FOUND' | 'AMBIGUOUS_TABLE'; message: string; hint: string };

type TableDef = { required?: unknown; properties?: Record<string, Record<string, unknown>> };

function tablesOf(schema: unknown): Record<string, TableDef> {
  if (schema && typeof schema === 'object' && 'tables' in schema) {
    const t = (schema as { tables: unknown }).tables;
    if (t && typeof t === 'object') return t as Record<string, TableDef>;
  }
  return {};
}

export function describeTable(schemas: SchemaVersion[], table: string, collection?: string): { collection: string; rows: DescribeRow[] } | DescribeFailure {
  const active = schemas.filter(s => s.is_active);
  if (collection !== undefined && !active.some(s => s.collection === collection)) {
    return { code: 'COLLECTION_NOT_FOUND', message: `No active schema for collection "${collection}".`, hint: 'Run `vsql schemas` to see what exists.' };
  }
  const scope = collection === undefined ? active : active.filter(s => s.collection === collection);
  const hits = scope.filter(s => Object.prototype.hasOwnProperty.call(tablesOf(s.json_schema), table));
  if (hits.length === 0) {
    return { code: 'TABLE_NOT_FOUND', message: `Table "${table}" not found${collection === undefined ? '' : ` in collection "${collection}"`}.`, hint: 'Run `vsql tables` to see every table by collection.' };
  }
  if (hits.length > 1) {
    const names = hits.map(h => h.collection).join(', ');
    return { code: 'AMBIGUOUS_TABLE', message: `Table "${table}" exists in more than one collection: ${names}.`, hint: `Say which: vsql describe ${table} <collection>` };
  }
  const def = tablesOf(hits[0].json_schema)[table];
  const required = Array.isArray(def.required) ? (def.required as unknown[]).map(String) : [];
  const props = def.properties && typeof def.properties === 'object' ? def.properties : {};
  const rows = Object.entries(props).map(([name, col]) => ({
    column_name: name,
    type: col && col.type !== undefined ? String(col.type) : '',
    format: col && col.format !== undefined ? String(col.format) : '',
    pk: col && col['x-vibe-pk'] ? 'yes' : '',
    auto_increment: col && col['x-vibe-auto-increment'] ? 'yes' : '',
    nullable: required.includes(name) ? 'NO' : 'YES',
  }));
  return { collection: hits[0].collection, rows };
}
