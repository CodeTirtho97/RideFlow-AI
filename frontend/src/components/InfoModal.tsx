import { useEffect } from 'react'

interface InfoModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
}

export function InfoModal({ open, title, onClose, children }: InfoModalProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="info-modal-overlay" onClick={onClose}>
      <div className="info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="info-modal-header">
          <h3>{title}</h3>
          <button className="info-modal-close" onClick={onClose} aria-label="Close details">
            ×
          </button>
        </div>
        <div className="info-modal-body">{children}</div>
      </div>
    </div>
  )
}
