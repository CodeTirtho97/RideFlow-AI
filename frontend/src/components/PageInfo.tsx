import { useState, useRef, useEffect } from 'react'

interface Props {
  title: string
  description: string
  tags: string[]
  accent: string
}

export function PageInfo({ title, description, tags, accent }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="page-info-wrap" ref={ref}>
      <button
        className={`page-info-btn${open ? ' active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="About this page"
      >
        i
      </button>

      {open && (
        <div className="page-info-popup" style={{ borderLeftColor: accent }}>
          <div className="page-info-popup-title">{title}</div>
          <p className="page-info-popup-desc">{description}</p>
          <div className="page-info-popup-tags">
            {tags.map(t => <span key={t} className="page-intro-tag">{t}</span>)}
          </div>
        </div>
      )}
    </div>
  )
}
