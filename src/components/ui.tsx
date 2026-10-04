import { useEffect, type ReactNode } from 'react'

/**
 * Shared primitives. These live outside App.tsx so route components can render
 * consistent headings, status text and metadata without App.tsx growing a
 * circular import.
 */

export function PageMeta({
  title,
  description,
  noIndex = false,
}: {
  title: string
  description: string
  noIndex?: boolean
}) {
  useEffect(() => {
    document.title = `${title} | Logistics VA Training Academy`
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'description'
      document.head.append(meta)
    }
    meta.content = description
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]')
    if (!robots) {
      robots = document.createElement('meta')
      robots.name = 'robots'
      document.head.append(robots)
    }
    robots.content = noIndex ? 'noindex, nofollow' : 'index, follow'
  }, [description, noIndex, title])
  return null
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="page">
      <p className="status" role="status">
        {label}
      </p>
    </div>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
      {error && <small className="error">{error}</small>}
    </label>
  )
}

export function Status({ children }: { children: ReactNode }) {
  return children ? (
    <p className="status" role="status">
      {children}
    </p>
  ) : null
}
