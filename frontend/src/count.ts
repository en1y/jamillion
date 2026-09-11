import { useEffect, useRef, useState } from 'react'

/** Ticks a number toward its new value over `ms`, eased out, so a score lands
 *  like a counter cranking rather than a value swapping. Its own file because a
 *  hook exported beside components breaks Vite's fast refresh for that file. */
export function useCountUp(value: number, ms = 700) {
  const [shown, setShown] = useState(value)
  const at = useRef(value)
  useEffect(() => {
    const from = at.current
    if (from === value) return
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    const start = performance.now()
    let raf = requestAnimationFrame(function tick(now) {
      const t = still ? 1 : Math.min(1, (now - start) / ms)
      at.current = Math.round(from + (value - from) * (1 - (1 - t) ** 3))
      setShown(at.current)
      if (t < 1) raf = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(raf)
  }, [value, ms])
  return shown
}
