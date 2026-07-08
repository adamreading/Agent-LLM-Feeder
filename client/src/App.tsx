import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { I18nProvider, useI18n, type Locale } from '@/lib/i18n'
import OnboardingPage from '@/pages/OnboardingPage'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import AgentPage from '@/pages/AgentPage'
import ModelWikiPage from '@/pages/ModelWikiPage'

const queryClient = new QueryClient()

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `relative text-sm px-1 py-4 transition-colors ${
          isActive
            ? 'text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-foreground'
            : 'text-muted-foreground hover:text-foreground'
        }`
      }
    >
      {children}
    </NavLink>
  )
}

function DarkModeToggle() {
  const { t } = useI18n()
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' && document.documentElement.classList.contains('dark')
  )

  useEffect(() => {
    const stored = localStorage.getItem('theme')
    if (stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark')
      setDark(true)
    }
  }, [])

  function toggle() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  return (
    <Button variant="ghost" size="sm" onClick={toggle} aria-label={t('toggleTheme')}>
      {dark ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
      )}
    </Button>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block size-2 rounded-full bg-foreground" />
      <span className="font-semibold tracking-tight text-sm">LLM Chatbot</span>
    </div>
  )
}

function LanguageToggle() {
  const { locale, setLocale, localeNames, t } = useI18n()
  const locales: Locale[] = ['en', 'fr', 'es']

  return (
    <div className="flex items-center gap-1 rounded-md border p-0.5" aria-label={t('language')}>
      {locales.map(item => (
        <Button
          key={item}
          variant={locale === item ? 'secondary' : 'ghost'}
          size="xs"
          onClick={() => setLocale(item)}
          aria-pressed={locale === item}
        >
          {localeNames[item]}
        </Button>
      ))}
    </div>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AppShell />
      </I18nProvider>
    </QueryClientProvider>
  )
}

function AppShell() {
  const { t } = useI18n()

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-40 bg-background/80 backdrop-blur border-b">
          <div className="max-w-6xl mx-auto px-6 flex items-center">
            <Brand />
            <nav className="flex items-center gap-6 ml-10">
              <NavItem to="/onboarding">{t('navOnboarding')}</NavItem>
              <NavItem to="/playground">{t('navChatbot')}</NavItem>
              <NavItem to="/agent">{t('navAgent')}</NavItem>
              <NavItem to="/wiki">{t('navWiki')}</NavItem>
              <NavItem to="/keys">{t('navKeys')}</NavItem>
              <NavItem to="/fallback">{t('navFallback')}</NavItem>
              <NavItem to="/analytics">{t('navAnalytics')}</NavItem>
            </nav>
            <div className="ml-auto py-2 flex items-center gap-2">
              <LanguageToggle />
              <DarkModeToggle />
            </div>
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-6 py-8">
          <Routes>
            <Route path="/" element={<Navigate to="/onboarding" replace />} />
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/playground" element={<PlaygroundPage />} />
            <Route path="/agent" element={<AgentPage />} />
            <Route path="/wiki" element={<ModelWikiPage />} />
            <Route path="/keys" element={<KeysPage />} />
            <Route path="/fallback" element={<FallbackPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/test" element={<Navigate to="/playground" replace />} />
            <Route path="/health" element={<Navigate to="/keys" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

export default App
