import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// AGENT//FEEDER cyberpunk flavor + scanlines. Flavor drives body[data-theme]
// (see index.css palettes); scanlines toggles the CRT overlay. Both persist to
// localStorage, mirroring how the old dark-mode toggle worked.
export type Flavor = 'holo' | 'noir' | 'acid'

export const FLAVORS: { id: Flavor; label: string; dot: string }[] = [
  { id: 'holo', label: 'Chrome & Holo', dot: '#8a5cff' },
  { id: 'noir', label: 'Neon Noir', dot: '#ff2ea6' },
  { id: 'acid', label: 'Acid Terminal', dot: '#39ff14' },
]

interface ThemeCtx {
  flavor: Flavor
  setFlavor: (f: Flavor) => void
  scanlines: boolean
  setScanlines: (v: boolean) => void
}

const Ctx = createContext<ThemeCtx | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [flavor, setFlavorState] = useState<Flavor>(() => {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem('cy-flavor') : null
    return (s === 'noir' || s === 'acid' || s === 'holo') ? s : 'holo'
  })
  const [scanlines, setScanlinesState] = useState<boolean>(() => {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem('cy-scanlines') : null
    return s == null ? true : s === '1'
  })

  useEffect(() => {
    document.body.dataset.theme = flavor
  }, [flavor])

  function setFlavor(f: Flavor) {
    setFlavorState(f)
    localStorage.setItem('cy-flavor', f)
  }
  function setScanlines(v: boolean) {
    setScanlinesState(v)
    localStorage.setItem('cy-scanlines', v ? '1' : '0')
  }

  return <Ctx.Provider value={{ flavor, setFlavor, scanlines, setScanlines }}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useTheme must be used within ThemeProvider')
  return c
}
