export type EdgeFunctionFailure = {
  message: string
  status: number | null
}

/** Reads the safe JSON error returned by an Edge Function without logging its response. */
export async function edgeFunctionFailure(
  error: unknown,
  fallback: string,
): Promise<EdgeFunctionFailure> {
  if (!error || typeof error !== 'object') return { message: fallback, status: null }

  const context = 'context' in error ? error.context : null
  if (!(context instanceof Response)) {
    const message = 'message' in error && typeof error.message === 'string' ? error.message : fallback
    return { message: message || fallback, status: null }
  }

  let message = fallback
  try {
    const payload = (await context.clone().json()) as { error?: unknown; message?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) message = payload.error
    else if (typeof payload.message === 'string' && payload.message.trim()) message = payload.message
  } catch {
    // Non-JSON failures retain the caller's safe fallback.
  }

  return { message, status: context.status }
}
