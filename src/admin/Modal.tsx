import { useEffect, useRef } from 'react'

type ModalProps = {
  title: string
  onClose: () => void
  children: React.ReactNode
  labelledBy?: string
}

/**
 * Modal dialog for destructive and reconciling admin actions.
 *
 * A native <dialog> is used so focus trapping, Escape handling and the top layer
 * come from the platform rather than from hand-rolled key handlers, which are
 * easy to get wrong in a way that makes an irreversible action reachable by
 * accident.
 */
export function Modal({ title, onClose, children, labelledBy = 'modal-title' }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (!node.open) node.showModal()
    return () => {
      if (node.open) node.close()
    }
  }, [])

  return (
    <dialog
      className="modal"
      ref={ref}
      aria-labelledby={labelledBy}
      // Escape and backdrop dismissal both route through onClose so a pending
      // request is never left running behind a closed dialog.
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
    >
      <h2 id={labelledBy}>{title}</h2>
      {children}
    </dialog>
  )
}

export function ImpactList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) {
    return (
      <div className="impact-list">
        <strong>{title}</strong>
        <p>Nothing else references this record.</p>
      </div>
    )
  }
  return (
    <div className="impact-list">
      <strong>{title}</strong>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

export function ModalActions({ children }: { children: React.ReactNode }) {
  return <div className="modal-actions">{children}</div>
}
