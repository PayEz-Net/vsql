import { fatal, handleApiError } from './errors.js';
import type { Conn } from './config.js';
import { signProxyRequest, nowSeconds } from './signing.js';

/**
 * v1.3.0 (PAY-1738): every route below is the HOSTED VibeSQL API's, read at source (PayEz-Core, PayEz.Vibe.Public.Api)
 * and measured on dev-93 by rigpert (63518). v1.2.0 had drifted from it on four routes:
 *   query          POST /v1/query                 -> POST /v1/vsql/query  (read-only for tenant data until RLS, card 88)
 *   schema update  PUT  /v1/schemas/{c}           -> POST /v1/schemas/{c} with { jsonSchema: <object> }
 *   insert         { clientId, data: "<string>" } -> the document object itself as the body
 *   schema show    read is_active / json_schema   -> the API answers camelCase (isActive / jsonSchema); both are read
 * The tenant comes from the credential (the sign-in or the KeelBase client id), never from a request field.
 */

export interface QueryResult {
  success: boolean;
  data?: Record<string, unknown>[];
  rows?: Record<string, unknown>[];
  meta?: { rowCount?: number; executionTimeMs?: number };
  rowCount?: number;
  executionTime?: number;
  error?: { code?: string; message?: string };
}

export interface SchemaVersion {
  collection_schema_id: number;
  collection: string;
  json_schema: unknown;
  version: number;
  is_active: boolean;
  created_at: string;
  created_by?: string | number | null;
}

type ApiBody = { success?: boolean; error?: { code?: string; message?: string }; [k: string]: unknown };

function stripTrailingSlash(host: string): string {
  return host.replace(/\/$/, '');
}

/**
 * Build the Authorization header. Bearer-only (since v1.2.0): the token must be a JWT (3 non-empty base64url parts);
 * a non-JWT fails loud, so a Secret / api-key header is never sent silently.
 */
function authHeader(token: string): string {
  const parts = token.split('.');
  const isJwt = parts.length === 3 && parts.every(p => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
  if (!isJwt) fatal('INVALID_TOKEN', 'Stored access token is not a JWT.', 'Run `vsql login` to authenticate.');
  return `Bearer ${token}`;
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init).catch(() => null);
  if (!res) fatal('CONNECTION_FAILED', `Could not connect to ${url}`, 'Check the host / VSQL_IDP_URL and your network.');
  return res;
}

/** VSQL_DEBUG=1: one line per call to stderr - where it went, never a credential or anything derived from one. */
function debug(line: string): void {
  if (process.env.VSQL_DEBUG) process.stderr.write(`[vsql] ${line}\n`);
}

/** Commands that change a schema. With a KeelBase secret they are refused (Jon, rigpert 63518): DDL uses the sign-in. */
const DDL_WITH_KEY_HINT =
  'Schema changes use your sign-in, not a KeelBase secret: unset VIBE_CLIENT_ID / VIBE_HMAC_KEY and run `vsql login`.';

/** Refuse a schema change up front when the connection is a KeelBase secret - before any diff or confirmation prompt. */
export function refuseDdlWithKey(conn: Conn, op: string): void {
  if (conn.kind === 'key') fatal('NOT_WITH_KEELBASE_SECRET', `\`${op}\` is not available with a KeelBase secret.`, DDL_WITH_KEY_HINT);
}

/**
 * ONE place every call is sent from.
 *  - bearer / anon: `${host}${path}` with the sign-in's access token (none for anon).
 *  - key: POST {IdP}/api/vibe/proxy with { endpoint: path, method, data } and X-Vibe-Client-Id / -Timestamp / -Signature
 *    (VibeProxyController's contract). The SAME path either way: the proxy forwards to the hosted API's `endpoint`.
 * The secret is used ONLY inside signProxyRequest: never in a header, a body, a URL or a debug line.
 */
async function send(conn: Conn, op: string, method: string, path: string, opts: { body?: unknown; ddl?: boolean } = {}): Promise<Response> {
  const { body, ddl } = opts;
  if (conn.kind === 'key') {
    if (ddl) fatal('NOT_WITH_KEELBASE_SECRET', `\`${op}\` is not available with a KeelBase secret.`, DDL_WITH_KEY_HINT);
    const timestamp = nowSeconds();
    const signature = signProxyRequest(conn.secret, timestamp, method, path);
    debug(`key-signing: POST ${conn.idp}/api/vibe/proxy endpoint=${path} method=${method.toUpperCase()} client=${conn.clientId} ts=${timestamp}`);
    return safeFetch(`${conn.idp}/api/vibe/proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Vibe-Client-Id': conn.clientId,
        'X-Vibe-Timestamp': String(timestamp),
        'X-Vibe-Signature': signature,
        'User-Agent': 'vsql-cli',
      },
      body: JSON.stringify({ endpoint: path, method: method.toUpperCase(), data: body ?? null }),
    });
  }
  const url = `${stripTrailingSlash(conn.host)}${path}`;
  debug(`${conn.kind}: ${method.toUpperCase()} ${url}`);
  const headers: Record<string, string> = { 'User-Agent': 'vsql-cli' };
  if (conn.kind === 'bearer') headers['Authorization'] = authHeader(conn.token);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return safeFetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

/**
 * Read a JSON reply. An empty or non-JSON body (a proxy error page, a 404 with no body) used to crash with a raw
 * "SyntaxError: Unexpected end of JSON input" stack trace (rigpert 63518); it now says the HTTP status and what came back.
 */
async function readJson(res: Response): Promise<ApiBody> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as ApiBody;
  } catch { /* fall through */ }
  const snippet = text.trim().replace(/\s+/g, ' ').slice(0, 200);
  fatal('BAD_RESPONSE', `HTTP ${res.status} ${res.statusText || ''}`.trim() + (snippet ? `: ${snippet}` : ' (empty body)'),
    res.status === 404 ? 'The server does not have this route; check the host (or VSQL_IDP_URL) points at VibeSQL.' : undefined);
}

/** A JSON reply that must be a success: a { success:false, error } body or a non-2xx is reported, never swallowed. */
async function expectOk(res: Response): Promise<ApiBody> {
  const body = await readJson(res);
  if (body.success === false || (!res.ok && body.success !== true)) {
    handleApiError({ success: false, error: body.error ?? { code: `HTTP_${res.status}`, message: `The server answered HTTP ${res.status}.` } });
  }
  return body;
}

export async function query(conn: Conn, sql: string): Promise<QueryResult> {
  // The hosted query passes the VibeSQL Server's own response through (VibeSqlController), so its shape is unchanged.
  const res = await send(conn, 'query', 'POST', '/v1/vsql/query', { body: { sql } });
  return await expectOk(res) as QueryResult;
}

export async function health(conn: Conn): Promise<{ status: string; version?: string; latencyMs: number }> {
  // /health is the API's public probe. Through the proxy it still proves the KeelBase id + secret: the proxy verifies
  // the signature before it forwards anything.
  const start = Date.now();
  const res = await send(conn, 'health', 'GET', '/health');
  const latencyMs = Date.now() - start;
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let err: ApiBody | null = null;
    try { err = JSON.parse(text); } catch { /* not JSON */ }
    if (err?.error) handleApiError({ success: false, error: err.error });
    fatal('CONNECTION_FAILED', `Health check failed (HTTP ${res.status})`, 'Check the host / VSQL_IDP_URL.');
  }
  // ASP.NET health checks answer plain text ("Healthy"); some builds answer JSON { status }. Accept both.
  try {
    const body = JSON.parse(text) as { status?: string; version?: string };
    return { status: body.status ?? 'healthy', version: body.version, latencyMs };
  } catch {
    return { status: text.trim() || 'healthy', latencyMs };
  }
}

/** Read a schema version whether the API answered camelCase (it does) or snake_case. */
function toVersion(v: Record<string, unknown>): SchemaVersion {
  const pick = (camel: string, snake: string) => (v[camel] !== undefined ? v[camel] : v[snake]);
  const raw = pick('jsonSchema', 'json_schema');
  return {
    collection_schema_id: Number(pick('collectionSchemaId', 'collection_schema_id')),
    collection: String(v.collection ?? ''),
    json_schema: typeof raw === 'string' ? JSON.parse(raw) : raw,
    version: Number(v.version),
    is_active: pick('isActive', 'is_active') === true,
    created_at: String(pick('createdAt', 'created_at') ?? ''),
    created_by: (pick('createdBy', 'created_by') as string | number | null | undefined) ?? null,
  };
}

export async function getVersions(conn: Conn, collection: string): Promise<SchemaVersion[]> {
  const res = await send(conn, 'schema versions', 'GET', `/v1/schemas/${encodeURIComponent(collection)}/versions`);
  const body = await expectOk(res);
  return ((body.data as Record<string, unknown>[] | undefined) ?? []).map(toVersion);
}

export async function getActiveSchema(conn: Conn, collection: string): Promise<{ version: number; schema: unknown; created_at: string }> {
  const versions = await getVersions(conn, collection);
  const active = versions.find(v => v.is_active);
  if (!active) fatal('NO_ACTIVE_SCHEMA', `No active schema found for "${collection}".`);
  return { version: active.version, schema: active.json_schema, created_at: active.created_at };
}

export async function updateSchema(conn: Conn, collection: string, schema: unknown): Promise<{ success: boolean; table_count?: number; version?: number }> {
  // POST with jsonSchema as an OBJECT (a string is 400 NOT_OBJECT). The API creates the next version and activates it.
  const jsonSchema = typeof schema === 'string' ? JSON.parse(schema) : schema;
  const res = await send(conn, 'schema update', 'POST', `/v1/schemas/${encodeURIComponent(collection)}`, { body: { jsonSchema }, ddl: true });
  const body = await expectOk(res);
  const data = (body.data ?? {}) as Record<string, unknown>;
  const n = (camel: string, snake: string) => { const x = data[camel] ?? data[snake]; return typeof x === 'number' ? x : undefined; };
  return { success: true, table_count: n('tableCount', 'table_count'), version: n('version', 'version') };
}

export async function insertDocument(conn: Conn, collection: string, table: string, doc: Record<string, unknown>): Promise<{ id?: number }> {
  // The body IS the document (DocumentsController.Create takes the raw JSON). Row writes are app runtime, so a KeelBase
  // secret may do this.
  const res = await send(conn, 'insert', 'POST', `/v1/collections/${encodeURIComponent(collection)}/tables/${encodeURIComponent(table)}`, { body: doc });
  const body = await expectOk(res);
  const data = (body.data ?? {}) as Record<string, unknown>;
  const id = data.document_id ?? data.documentId ?? data.id;
  return { id: typeof id === 'number' ? id : undefined };
}

/**
 * Read a table's rows back (rigpert 63609: without this a developer could write rows but never see them - hosted SQL
 * does not see collection tables). GET /v1/collections/{c}/tables/{t}?page&pageSize; each item is
 * { document_id, data } with data an object or a JSON string. Read-only, so a KeelBase secret may do it.
 * From rigpert's PR #2 (rigpert/pay-1738-api-resync), moved onto send() so key-signing covers it.
 */
export async function listRows(conn: Conn, collection: string, table: string, page = 1, pageSize = 20): Promise<{ rows: Record<string, unknown>[]; total?: number }> {
  const path = `/v1/collections/${encodeURIComponent(collection)}/tables/${encodeURIComponent(table)}?page=${page}&pageSize=${pageSize}`;
  const res = await send(conn, 'rows', 'GET', path);
  const body = await expectOk(res) as ApiBody & { pagination?: { totalCount?: number } };
  const items = Array.isArray(body.data) ? body.data as Array<{ document_id?: number; documentId?: number; data?: unknown }> : [];
  const rows = items.map(d => {
    let doc: unknown = d.data ?? {};
    if (typeof doc === 'string') {
      try { doc = JSON.parse(doc); } catch { doc = { data: doc }; }
    }
    return { document_id: d.document_id ?? d.documentId, ...(doc as Record<string, unknown>) };
  });
  return { rows, total: body.pagination?.totalCount };
}

/** The tenant's collections: GET /v1/collections (a bare array, or { collections: [...] }). Read-only. */
export async function listCollections(conn: Conn): Promise<Record<string, unknown>[]> {
  const res = await send(conn, 'collections', 'GET', '/v1/collections');
  const body = await expectOk(res);
  const d = body.data as unknown;
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  const inner = (d as { collections?: unknown } | undefined)?.collections;
  return Array.isArray(inner) ? inner as Record<string, unknown>[] : [];
}

export async function rollback(conn: Conn, collection: string, targetVersion?: number): Promise<{ collection: string; restored_version: number; table_count: number; message: string }> {
  const bodyObj = targetVersion != null ? { targetVersion } : {};
  const res = await send(conn, 'rollback', 'POST', `/v1/schemas/${encodeURIComponent(collection)}/rollback`, { body: bodyObj, ddl: true });
  const body = await expectOk(res);
  const d = (body.data ?? body) as Record<string, unknown>;
  const pick = (camel: string, snake: string) => d[camel] ?? d[snake];
  return {
    collection: String(pick('collection', 'collection') ?? collection),
    restored_version: Number(pick('restoredVersion', 'restored_version')),
    table_count: Number(pick('tableCount', 'table_count')),
    message: String(d.message ?? ''),
  };
}
