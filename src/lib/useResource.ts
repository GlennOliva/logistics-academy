import { useCallback, useEffect, useState } from 'react'

export type ResourceResult<T> = { value: T; error: string }

/**
 * Loads one resource and keeps it in step with its inputs.
 *
 * The fetcher only returns data; the state write always happens inside this
 * hook, after the await. That keeps three things true at once: the first paint
 * is not a spinner flash, a slow earlier response can never overwrite a newer
 * one, and nothing is written after the component or its inputs go away.
 */
export function useResource<T>(
  fetcher: () => Promise<ResourceResult<T>>,
  initialValue: T,
  options: { refreshOnFocus?: boolean } = {},
) {
  const { refreshOnFocus = false } = options
  const [state, setState] = useState<{ value: T; error: string; loaded: boolean }>({
    value: initialValue,
    error: '',
    loaded: false,
  })

  const apply = useCallback((result: ResourceResult<T>) => {
    setState({ value: result.value, error: result.error, loaded: true })
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await fetcher()
      if (cancelled) return
      apply(result)
    })()
    return () => {
      cancelled = true
    }
  }, [apply, fetcher])

  const reload = useCallback(async () => {
    apply(await fetcher())
  }, [apply, fetcher])

  // Access is granted by an administrator in a different browser tab, so a tab
  // that was left open would otherwise keep showing the pre-approval state.
  // Reloading on focus and on tab re-activation means a returning student sees
  // their course without needing a manual full-page reload.
  useEffect(() => {
    if (!refreshOnFocus) return
    const refresh = () => {
      if (document.visibilityState === 'visible') void reload()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [refreshOnFocus, reload])

  return {
    value: state.value,
    error: state.error,
    loading: !state.loaded,
    reload,
    /** True once the resource has arrived, so callers can tell "empty" from "still loading". */
    loaded: state.loaded,
  }
}