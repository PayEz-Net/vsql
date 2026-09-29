export function fatal(code: string, message: string, hint?: string): never {
  process.stderr.write(`Error [${code}]: ${message}\n`);
  if (hint) process.stderr.write(`  Hint: ${hint}\n`);
  process.exit(1);
}

export function handleApiError(body: { success: false; error?: { code?: string; message?: string } }): never {
  const code = body.error?.code ?? 'UNKNOWN';
  const message = body.error?.message ?? 'Unknown error from VibeSQL server';
  const hints: Record<string, string> = {
    INVALID_SQL: 'Check for typos in your SQL query',
    UNSAFE_QUERY: 'Use WHERE 1=1 to explicitly update all rows',
    UNAUTHORIZED: 'Your session may have expired. Run `vsql login` to re-authenticate.',
    VERSION_NOT_FOUND: 'Use `vsql rollback <collection> --list` to see available versions',
    // PAY-1978 (rigpert 67321): a mismatched signature is usually a stale/shadowed VIBE_HMAC_KEY
    // (a saved profile, a .env, a leftover shell export) - `vsql health` now names where the
    // client id AND the key each came from, which is exactly the mismatch this points at.
    SIGNATURE_MISMATCH: 'Run `vsql health` - it names where your client id and key each came from (env, .env or a saved profile), never the values. A stale or shadowed VIBE_HMAC_KEY is the usual cause.',
  };
  fatal(code, message, hints[code]);
}
