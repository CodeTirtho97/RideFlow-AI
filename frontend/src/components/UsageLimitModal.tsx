import { useNavigate } from 'react-router-dom'

interface Props {
  page: string
  runsUsed: number
  limit: number
  isGlobal?: boolean
}

export function UsageLimitModal({ page, runsUsed, limit, isGlobal = false }: Props) {
  const navigate = useNavigate()

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0, 0, 0, 0.82)',
      backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: '32px 28px 24px',
        maxWidth: 400, width: '90%',
        textAlign: 'center',
        boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
      }}>
        {/* Icon */}
        <div style={{ fontSize: 44, marginBottom: 12, lineHeight: 1 }}>🔒</div>

        {/* Heading */}
        <h2 style={{
          fontSize: 20, fontWeight: 800,
          color: 'var(--text)', margin: '0 0 8px',
          letterSpacing: '-0.3px',
        }}>
          Demo Limit Reached
        </h2>

        {/* Sub-text */}
        {isGlobal ? (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, margin: '0 0 4px' }}>
              The demo limit was reached in{' '}
              <strong style={{ color: 'var(--text)' }}>another open RideFlow tab</strong>.
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 22px' }}>
              All RideFlow sessions are now locked. Return to home to start a fresh session.
            </p>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, margin: '0 0 4px' }}>
              You've used all{' '}
              <strong style={{ color: 'var(--text)' }}>{limit} free runs</strong> of the{' '}
              <strong style={{ color: 'var(--text)' }}>{page}</strong>.
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 22px' }}>
              This demo runs on shared backend resources.{' '}
              <span style={{ color: 'var(--red)', fontWeight: 600 }}>{runsUsed}/{limit}</span> sessions used.
              Thank you for trying RideFlow AI!
            </p>
          </>
        )}

        {/* ── Return to Home ── */}
        <div style={{ borderTop: '1px solid var(--border)', marginBottom: 18 }} />
        <button
          onClick={() => navigate('/')}
          style={{
            width: '100%', padding: '13px',
            borderRadius: 8,
            background: 'var(--red)', color: '#fff',
            border: 'none', fontSize: 14, fontWeight: 700,
            cursor: 'pointer',
            letterSpacing: '0.01em',
          }}
        >
          Return to Home
        </button>
      </div>
    </div>
  )
}
