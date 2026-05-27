import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'

// ── Types ─────────────────────────────────────────────────────────────────

export type ToastType = 'error' | 'warning' | 'success' | 'info'

export interface ToastOptions {
  type: ToastType
  title: string
  message: string
  steps?: string[]
  duration?: number // ms — omit to use defaults
}

interface ToastItem extends Required<Omit<ToastOptions, 'steps'>> {
  id: string
  steps: string[]
}

interface ToastCtx {
  toast: (opts: ToastOptions) => void
}

// ── Context ───────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastCtx>({ toast: () => {} })

export function useToast() {
  return useContext(ToastContext)
}

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_DURATION: Record<ToastType, number> = {
  error:   8000,
  warning: 6000,
  success: 4000,
  info:    5000,
}

const TYPE_ICON: Record<ToastType, string> = {
  error:   '✕',
  warning: '!',
  success: '✓',
  info:    'i',
}

const TYPE_COLOR: Record<ToastType, string> = {
  error:   '#dc2626',
  warning: '#d97706',
  success: '#16a34a',
  info:    '#2563eb',
}

// ── Single toast card ─────────────────────────────────────────────────────

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const color = TYPE_COLOR[item.type]

  useEffect(() => {
    const id = setTimeout(onDismiss, item.duration)
    return () => clearTimeout(id)
  }, [item.duration, onDismiss])

  return (
    <div
      className="toast-card"
      role="alert"
      aria-live="assertive"
      style={{ '--toast-color': color, '--toast-dur': `${item.duration}ms` } as React.CSSProperties}
    >
      {/* ── Header ── */}
      <div className="toast-header">
        <span className="toast-icon">{TYPE_ICON[item.type]}</span>
        <span className="toast-title">{item.title}</span>
        <button className="toast-close" onClick={onDismiss} aria-label="Dismiss">✕</button>
      </div>

      {/* ── Body ── */}
      <p className="toast-message">{item.message}</p>

      {/* ── Steps ── */}
      {item.steps.length > 0 && (
        <ul className="toast-steps">
          {item.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      )}

      {/* ── Progress drain ── */}
      <div className="toast-bar" />
    </div>
  )
}

// ── Container ─────────────────────────────────────────────────────────────

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-container" aria-label="Notifications">
      {toasts.map(t => (
        <ToastCard key={t.id} item={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  )
}

// ── Provider ──────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const counter = useRef(0)

  const toast = useCallback((opts: ToastOptions) => {
    const id = `t${++counter.current}`
    const duration = opts.duration ?? DEFAULT_DURATION[opts.type]
    setToasts(prev => [
      ...prev.slice(-2), // keep max 3 visible
      { ...opts, id, duration, steps: opts.steps ?? [] },
    ])
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}
