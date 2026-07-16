import { Component, type ErrorInfo, type ReactNode } from 'react'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const

interface Props { children: ReactNode }
interface State { error: Error | null }

// Catches render/lifecycle errors in the routed page and shows a recoverable
// message INSTEAD of unmounting the whole app. It wraps only <Routes> (the
// nav/header/footer live outside it), so when a page throws the chrome stays put
// and the user can navigate away — no more blank-screen "no escape". Keyed on the
// route in App, so navigating to another page clears the error automatically.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface it for debugging; the app itself stays alive.
    console.error('[ErrorBoundary] page crashed:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div style={{ maxWidth: 720, margin: '60px auto', padding: '0 24px' }}>
        <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// PAGE ERROR</div>
        <h1 style={{ margin: '0 0 12px', fontSize: 30, fontWeight: 700, letterSpacing: 1 }}>THIS PAGE HIT AN ERROR</h1>
        <p style={{ color: 'var(--dim)', fontSize: 14, lineHeight: 1.6, margin: '0 0 16px' }}>
          The rest of the app is fine — use the navigation above to go to another page. If it keeps happening, reload.
        </p>
        <pre style={{
          ...mono, fontSize: 12, color: 'var(--ink)', background: 'var(--panel)', border: '1px solid var(--line)',
          padding: 14, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '0 0 16px',
        }}>{error.message || String(error)}</pre>
        <button
          onClick={() => window.location.reload()}
          className="cy-btn"
          style={{
            all: 'unset', cursor: 'pointer', ...mono, fontSize: 12, fontWeight: 700, letterSpacing: 1,
            padding: '9px 18px', background: 'var(--acc)', color: '#000', border: '1px solid var(--acc)',
          }}
        >RELOAD PAGE</button>
      </div>
    )
  }
}
