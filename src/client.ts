import { fatal, handleApiError } from './errors.js';

export interface QueryResult {
  success: boolean;
  data?: Record<string, unknown>[];
  rows?: Record<string, unknown>[];
  meta?: { rowCount?: number; executionTimeMs?: number };
  rowCount?: number;
  executionTime?: number;
  error?: { code?: string; message?: string };
}

export interface HealthResult {
  status: string;
  version?: string;
}

export interface SchemaVersion {
  collection_schema_id: number;
  collection: string;
  json_schema: unknown;
  version: number;
  is_active: boolean;
  created_at: string;
  created_by?: string | null;
}

function stripTrailingSlash(host: string): string {
  return host.replace(/\/$/, '');
}

/**
 * Build the Authorization header. Bearer-only (v1.2.0): the token must be a
 * JWT (3 non-empty base64url parts); a non-JWT fails loud — the legacy
 * Secret / api-key path is removed, so we never silently send a Secret header.
 */
function authHeader(token: string): string {
  const parts = token.split('.');
  const isJwt = parts.length === 3 && parts.every(p => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
  if (!isJwt) fatal('INVALID_TOKEN', 'Stored access token is not a JWT.', 'Run `vsql login` to authenticate.');
  return `Bearer ${token}`;
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init).catch(() => null);
  if (!res) fatal('CONNECTION_FAILED', `Could not connect to ${url}`, 'Check that the VibeSQL server is running and the host is correct');
  return res;
}

/**
 * Read a JSON body without ever throwing a raw parser stack trace. An empty or non-JSON body
 * becomes a named error carrying the HTTP status and the route, which is what the user needs
 * to act on (a 404 here almost always means VSQL_HOST points at the wrong service).
 */
async function readJson<T>(res: Response, url: string): Promise<T> {
  const text = await res.text().catch(() => '');
  const route = url.replace(/^https?:\/\/[^/]+/, '');
  if (!text.trim()) {
    const hint = res.status === 401 ? 'Your session may have expired. Run `vsql login` to re-authenticate.'
      : res.status === 404 ? 'This server has no such route. Check that VSQL_HOST points at the Vibe API.'
      : res.status === 405 ? 'The server refused this method on that route. Update the CLI.'
      : undefined;
    fatal(`HTTP_${res.status}`, `Empty response from ${route} (HTTP ${res.status}).`, hint);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    fatal(`HTTP_${res.status}`, `Non-JSON response from ${route} (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

type ApiBody<T> = { success: boolean; data?: T; error?: { code?: string; message?: string } };

function failIfError<T>(body: ApiBody<T>): void {
  if (!body.success) handleApiError(body as { success: false; error?: { code?: string; message?: string } });
}

export async function query(host: string, token: string, sql: string): Promise<QueryResult> {
  // The Vibe API serves SQL at /v1/vsql/query. It is READ-ONLY by design (no client row-scope yet):
  // DDL goes through `vsql schema update`, row writes through `vsql insert`.
  const url = `${stripTrailingSlash(host)}/v1/vsql/query`;
  const res = await safeFetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  const body = await readJson<QueryResult>(res, url);
  if (!body.success) handleApiError(body as { success: false; error?: { code?: string; message?: string } });
  return body;
}

export async function health(host: string): Promise<{ status: string; version?: string; latencyMs: number }> {
  const start = Date.now();
  const url = `${stripTrailingSlash(host)}/health`;
  const res = await safeFetch(url);
  const latencyMs = Date.now() - start;

  if (!res.ok) fatal('CONNECTION_FAILED', `Health check failed (HTTP ${res.status})`, 'Check that the VibeSQL server is running and the host is correct');

  const body = await readJson<HealthResult>(res, url);
  return { status: body.status ?? 'healthy', version: body.version, latencyMs };
}

export async function getVersions(host: string, token: string, collection: string): Promise<SchemaVersion[]> {
  const url = `${stripTrailingSlash(host)}/v1/schemas/${encodeURIComponent(collection)}/versions`;
  const res = await safeFetch(url, { headers: { 'Authorization': authHeader(token) } });

  // The Vibe API answers in camelCase (jsonSchema, isActive, createdAt); older servers used snake_case.
  const body = await readJson<ApiBody<Record<string, unknown>[]>>(res, url);
  failIfError(body);
  return (body.data ?? []).map(v => {
    const raw = (v.jsonSchema ?? v.json_schema) as unknown;
    return {
      collection_schema_id: Number(v.collectionSchemaId ?? v.collection_schema_id),
      collection: String(v.collection),
      json_schema: typeof raw === 'string' ? JSON.parse(raw) : raw,
      version: Number(v.version),
      is_active: Boolean(v.isActive ?? v.is_active),
      created_at: String(v.createdAt ?? v.created_at),
      created_by: (v.createdBy ?? v.created_by ?? null) as string | null,
    };
  });
}

export async function getActiveSchema(host: string, token: string, collection: string): Promise<{ version: number; schema: unknown; created_at: string }> {
  const versions = await getVersions(host, token, collection);
  const active = versions.find(v => v.is_active);
  if (!active) fatal('NO_ACTIVE_SCHEMA', `No active schema found for "${collection}".`);
  return { version: active.version, schema: active.json_schema, created_at: active.created_at };
}

export async function updateSchema(host: string, token: string, collection: string, schema: unknown, clientId: number = 0): Promise<{ success: boolean; table_count?: number; version?: number }> {
  const url = `${stripTrailingSlash(host)}/v1/schemas/${encodeURIComponent(collection)}`;
  // POST creates or replaces the collection schema. jsonSchema goes as a JSON OBJECT; the API rejects a string (NOT_OBJECT).
  const jsonSchema = typeof schema === 'string' ? JSON.parse(schema) : schema;
  const payload: Record<string, unknown> = { jsonSchema };
  if (clientId) payload.clientId = clientId;
  const res = await safeFetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await readJson<ApiBody<{ version?: number; tableCount?: number; table_count?: number }>>(res, url);
  failIfError(body);
  return { success: true, table_count: body.data?.tableCount ?? body.data?.table_count, version: body.data?.version };
}

export async function insertDocument(host: string, token: string, collection: string, table: string, data: Record<string, unknown>): Promise<{ id?: number; generatedKeys?: Record<string, unknown> }> {
  const url = `${stripTrailingSlash(host)}/v1/collections/${encodeURIComponent(collection)}/tables/${encodeURIComponent(table)}`;
  // The document IS the body: its fields go at the top level, not wrapped in { data }.
  const res = await safeFetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  const body = await readJson<ApiBody<{ document_id?: number; id?: number }> & { generatedKeys?: Record<string, unknown> }>(res, url);
  failIfError(body);
  return { id: body.data?.document_id ?? body.data?.id, generatedKeys: body.generatedKeys };
}

export async function listRows(host: string, token: string, collection: string, table: string, page = 1, pageSize = 20): Promise<{ rows: Record<string, unknown>[]; total?: number }> {
  const url = `${stripTrailingSlash(host)}/v1/collections/${encodeURIComponent(collection)}/tables/${encodeURIComponent(table)}?page=${page}&pageSize=${pageSize}`;
  const res = await safeFetch(url, { headers: { 'Authorization': authHeader(token) } });
  const body = await readJson<ApiBody<Array<{ document_id?: number; data?: unknown }>> & { pagination?: { totalCount?: number } }>(res, url);
  failIfError(body);
  const rows = (body.data ?? []).map(d => {
    const doc = typeof d.data === 'string' ? JSON.parse(d.data) : (d.data ?? {});
    return { document_id: d.document_id, ...(doc as Record<string, unknown>) };
  });
  return { rows, total: body.pagination?.totalCount };
}

export async function listCollections(host: string, token: string): Promise<Record<string, unknown>[]> {
  const url = `${stripTrailingSlash(host)}/v1/collections`;
  const res = await safeFetch(url, { headers: { 'Authorization': authHeader(token) } });
  const body = await readJson<ApiBody<unknown>>(res, url);
  failIfError(body);
  const d = body.data as unknown;
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  const inner = (d as { collections?: unknown })?.collections;
  return Array.isArray(inner) ? inner as Record<string, unknown>[] : [];
}

export async function rollback(host: string, token: string, collection: string, targetVersion?: number): Promise<{ collection: string; restored_version: number; table_count: number; message: string }> {
  const bodyObj = targetVersion != null ? { targetVersion } : {};
  const url = `${stripTrailingSlash(host)}/v1/schemas/${encodeURIComponent(collection)}/rollback`;
  const res = await safeFetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(bodyObj),
  });

  const body = await readJson<ApiBody<{ collection: string; restored_version: number; table_count: number; message: string }>>(res, url);
  failIfError(body);
  return body.data!;
}
