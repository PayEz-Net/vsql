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
    UNAUTHORIZED: 'Check your API key with `vsql config show`',
    VERSION_NOT_FOUND: 'Use `vsql rollback <collection> --list` to see available versions',
  };
  fatal(code, message, hints[code]);
}
