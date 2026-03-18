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

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init).catch(() => null);
  if (!res) fatal('CONNECTION_FAILED', `Could not connect to ${url}`, 'Check that the VibeSQL server is running and the host is correct');
  return res;
}

export async function query(host: string, key: string, sql: string): Promise<QueryResult> {
  const res = await safeFetch(`${stripTrailingSlash(host)}/v1/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Secret ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  const body = await res.json() as QueryResult;
  if (!body.success) handleApiError(body as { success: false; error?: { code?: string; message?: string } });
  return body;
}

export async function health(host: string): Promise<{ status: string; version?: string; latencyMs: number }> {
  const start = Date.now();
  const res = await safeFetch(`${stripTrailingSlash(host)}/v1/health`);
  const latencyMs = Date.now() - start;

  if (!res.ok) fatal('CONNECTION_FAILED', `Health check failed (HTTP ${res.status})`, 'Check that the VibeSQL server is running and the host is correct');

  const body = await res.json() as HealthResult;
  return { status: body.status ?? 'healthy', version: body.version, latencyMs };
}

export async function getVersions(host: string, key: string, collection: string): Promise<SchemaVersion[]> {
  const res = await safeFetch(`${stripTrailingSlash(host)}/v1/schemas/${encodeURIComponent(collection)}/versions`, {
    headers: { 'Authorization': `Secret ${key}` },
  });

  const body = await res.json() as { success: boolean; data?: SchemaVersion[]; error?: { code?: string; message?: string } };
  if (!body.success) handleApiError(body as { success: false; error?: { code?: string; message?: string } });
  // json_schema may come as string from VibeSQL Server — parse it
  return (body.data ?? []).map(v => ({
    ...v,
    json_schema: typeof v.json_schema === 'string' ? JSON.parse(v.json_schema) : v.json_schema,
  }));
}

export async function getActiveSchema(host: string, key: string, collection: string): Promise<{ version: number; schema: unknown; created_at: string }> {
  const versions = await getVersions(host, key, collection);
  const active = versions.find(v => v.is_active);
  if (!active) fatal('NO_ACTIVE_SCHEMA', `No active schema found for "${collection}".`);
  return { version: active.version, schema: active.json_schema, created_at: active.created_at };
}

export async function updateSchema(host: string, key: string, collection: string, schema: unknown, clientId: number = 0): Promise<{ success: boolean; table_count?: number; version?: number }> {
  const res = await safeFetch(`${stripTrailingSlash(host)}/v1/schemas/${encodeURIComponent(collection)}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Secret ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clientId, jsonSchema: typeof schema === 'string' ? schema : JSON.stringify(schema) }),
  });

  const body = await res.json() as { success: boolean; data?: { table_count?: number; version?: number }; error?: { code?: string; message?: string } };
  if (!body.success) handleApiError(body as { success: false; error?: { code?: string; message?: string } });
  return { success: true, table_count: body.data?.table_count, version: body.data?.version };
}

export async function insertDocument(host: string, key: string, collection: string, table: string, data: Record<string, unknown>, clientId: number = 0): Promise<{ id?: number }> {
  const res = await safeFetch(`${stripTrailingSlash(host)}/v1/collections/${encodeURIComponent(collection)}/tables/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: {
      'Authorization': `Secret ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clientId, data: typeof data === 'string' ? data : JSON.stringify(data) }),
  });

  const body = await res.json() as { success: boolean; data?: { id?: number; document_id?: number }; error?: { code?: string; message?: string } };
  if (!body.success) handleApiError(body as { success: false; error?: { code?: string; message?: string } });
  return { id: body.data?.document_id ?? body.data?.id };
}

export async function rollback(host: string, key: string, collection: string, targetVersion?: number): Promise<{ collection: string; restored_version: number; table_count: number; message: string }> {
  const bodyObj = targetVersion != null ? { targetVersion } : {};
  const res = await safeFetch(`${stripTrailingSlash(host)}/v1/schemas/${encodeURIComponent(collection)}/rollback`, {
    method: 'POST',
    headers: {
      'Authorization': `Secret ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(bodyObj),
  });

  const body = await res.json() as { success: boolean; data?: { collection: string; restored_version: number; table_count: number; message: string }; error?: { code?: string; message?: string } };
  if (!body.success) handleApiError(body as { success: false; error?: { code?: string; message?: string } });
  return body.data!;
}
