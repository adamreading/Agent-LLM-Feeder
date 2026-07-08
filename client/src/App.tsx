import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n'
import { ThemeProvider, useTheme, FLAVORS } from '@/lib/theme'
import OnboardingPage from '@/pages/OnboardingPage'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import AgentPage from '@/pages/AgentPage'
import ModelWikiPage from '@/pages/ModelWikiPage'
import ModelDetailPage from '@/pages/ModelDetailPage'

const queryClient = new QueryClient()

const NAV = [
  { to: '/onboarding', label: 'ONBOARD' },
  { to: '/wiki', label: 'MODEL WIKI' },
  { to: '/playground', label: 'CHATBOT' },
  { to: '/agent', label: 'AGENT' },
  { to: '/keys', label: 'KEY VAULT' },
  { to: '/fallback', label: 'FALLBACK' },
  { to: '/analytics', label: 'ANALYTICS' },
]

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} className="cy-txt-acc" style={({ isActive }) => ({
      all: 'unset',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      padding: '0 14px',
      fontSize: '13px',
      fontWeight: 600,
      letterSpacing: '1.5px',
      color: isActive ? 'var(--acc)' : 'var(--dim)',
      borderBottom: `2px solid ${isActive ? 'var(--acc)' : 'transparent'}`,
      textShadow: isActive ? '0 0 12px var(--glow)' : 'none',
    })}>
      {label}
    </NavLink>
  )
}

function FlavorSwitch() {
  const { flavor, setFlavor, scanlines, setScanlines } = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--line)', padding: '5px 8px' }}>
        <span className="cy-mono" style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 1 }}>FLAVOR</span>
        {FLAVORS.map(f => (
          <button key={f.id} onClick={() => setFlavor(f.id)} title={f.label} style={{
            all: 'unset', cursor: 'pointer', width: 16, height: 16, transform: 'rotate(45deg)',
            background: f.dot, outline: `1px solid ${flavor === f.id ? f.dot : 'transparent'}`, outlineOffset: 2,
          }} />
        ))}
      </div>
      <button
        onClick={() => setScanlines(!scanlines)}
        title="Toggle CRT scanlines"
        className="cy-mono cy-hover-acc"
        style={{
          all: 'unset', cursor: 'pointer', fontSize: 9, letterSpacing: 1,
          color: scanlines ? 'var(--acc)' : 'var(--dim)', border: '1px solid var(--line)',
          padding: '6px 8px',
        }}
      >
        SCAN {scanlines ? 'ON' : 'OFF'}
      </button>
    </div>
  )
}

function Header() {
  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', gap: 20,
      padding: '0 28px', height: 60, background: 'color-mix(in oklab, var(--bg) 82%, transparent)',
      backdropFilter: 'blur(10px)', borderBottom: '1px solid var(--line)', flexWrap: 'wrap',
    }}>
      <NavLink to="/wiki" style={{ all: 'unset', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
        <div style={{
          width: 26, height: 26, transform: 'rotate(45deg)', border: '2px solid var(--acc)',
          boxShadow: '0 0 12px var(--glow), inset 0 0 8px var(--glow)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{ width: 8, height: 8, background: 'var(--acc2)', boxShadow: '0 0 8px var(--acc2)' }} />
        </div>
        <div style={{ lineHeight: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: 2 }}>AGENT<span style={{ color: 'var(--acc)' }}>//</span>FEEDER</div>
          <div className="cy-mono" style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 1 }}>FREE-TIER LLM ROUTER v2.6</div>
        </div>
      </NavLink>
      <nav style={{ display: 'flex', gap: 2, height: '100%', flexWrap: 'wrap' }}>
        {NAV.map(n => <NavItem key={n.to} to={n.to} label={n.label} />)}
      </nav>
      <div style={{ flex: 1 }} />
      <FlavorSwitch />
      <div className="cy-mono" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, letterSpacing: 1, color: 'var(--good)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--good)', boxShadow: '0 0 8px var(--good)', animation: 'ledpulse 2s infinite' }} />
        ROUTER ONLINE
      </div>
    </header>
  )
}

function Scanlines() {
  const { scanlines } = useTheme()
  if (!scanlines) return null
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 90, background: 'repeating-linear-gradient(0deg, rgba(0,0,0,.16) 0px, rgba(0,0,0,.16) 1px, transparent 1px, transparent 3px)' }} />
      <div style={{ position: 'fixed', left: 0, right: 0, top: 0, height: 110, pointerEvents: 'none', zIndex: 91, background: 'linear-gradient(180deg, transparent, var(--glow), transparent)', opacity: 0.07, animation: 'scandrift 9s linear infinite' }} />
    </>
  )
}

function Footer() {
  return (
    <footer className="cy-mono" style={{
      borderTop: '1px solid var(--line)', padding: '16px 28px', display: 'flex',
      justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', fontSize: 10, color: 'var(--dim)', letterSpacing: 1,
    }}>
      <span>AGENT//FEEDER — local router · keys never leave your machine</span>
      <span>NIGHT CITY UPTIME 99.4%</span>
    </footer>
  )
}

function AppShell() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <div className="cy" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Scanlines />
        <Header />
        <div style={{ flex: 1 }}>
          <Routes>
            <Route path="/" element={<Navigate to="/wiki" replace />} />
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/wiki" element={<ModelWikiPage />} />
            <Route path="/wiki/:slug" element={<ModelDetailPage />} />
            <Route path="/playground" element={<PlaygroundPage />} />
            <Route path="/agent" element={<AgentPage />} />
            <Route path="/keys" element={<KeysPage />} />
            <Route path="/fallback" element={<FallbackPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/test" element={<Navigate to="/playground" replace />} />
            <Route path="/health" element={<Navigate to="/keys" replace />} />
          </Routes>
        </div>
        <Footer />
      </div>
    </BrowserRouter>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider>
          <AppShell />
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  )
}

export default App
