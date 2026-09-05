import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowUpRight, LoaderCircle, X } from 'lucide-react'

export function Spinner() {
  return <LoaderCircle className="spin" size={16} aria-hidden="true" />
}
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-label={title}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect()
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose()
        }
      }}
    >
      <header className="modal-header">
        <h2>{title}</h2>
        <button className="icon-button" aria-label={`关闭${title}`} onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="modal-scroll">{children}</div>
    </dialog>
  )
}
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="button secondary" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRight size={15} />
    </a>
  )
}
