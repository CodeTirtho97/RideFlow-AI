import { useState, useRef, useEffect } from 'react'
import type { LucideProps } from 'lucide-react'
import { Info } from 'lucide-react'

interface Props {
  icon: React.ComponentType<LucideProps>
  title: string
  subtitle: string
  accent: string
  accentBg: string
  infoDescription: string
  infoTags: string[]
}

export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  accent,
  accentBg,
  infoDescription,
  infoTags,
}: Props) {
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
    <div className="page-header">
      <div className="page-header-inner">
        <div className="page-header-icon" style={{ background: accentBg, color: accent }}>
          <Icon size={22} strokeWidth={1.75} />
        </div>
        <div className="page-header-content">
          <div className="page-header-title-row" ref={ref}>
            <h1 className="page-header-title">{title}</h1>
            <button
              className={`page-info-btn${open ? ' active' : ''}`}
              onClick={() => setOpen(o => !o)}
              title="About this page"
            >
              <Info size={11} strokeWidth={2.5} />
            </button>
            {open && (
              <div className="page-info-popup" style={{ borderLeftColor: accent }}>
                <div className="page-info-popup-title">{title}</div>
                <p className="page-info-popup-desc">{infoDescription}</p>
                <div className="page-info-popup-tags">
                  {infoTags.map(t => <span key={t} className="page-intro-tag">{t}</span>)}
                </div>
              </div>
            )}
          </div>
          <p className="page-header-subtitle">{subtitle}</p>
        </div>
      </div>
    </div>
  )
}
