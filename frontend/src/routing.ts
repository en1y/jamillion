// The router: five screens and one path segment, on the History API.
//
// A link stays a plain <a href="/editor/2026-09-09">, so middle-click, ctrl-click
// and "open in a new tab" all still do what they look like they do; one delegated
// listener takes over the ordinary left-click and turns it into a pushState.
// Imperative moves -- picking a date, switching an admin tab -- call navigate().
//
// ponytail: no router dependency. Revisit when a screen needs two segments.
import { useEffect, useState } from 'react'

const MOVED = 'jam:navigate'

export function navigate(to: string) {
  if (to === location.pathname) return
  history.pushState(null, '', to)
  scrollTo(0, 0)
  dispatchEvent(new Event(MOVED))   // pushState fires nothing on its own
}

/** '/editor/2026-09-09' -> ['editor', '2026-09-09']. The launchpad is ['', '']. */
export function routeOf(path: string): [string, string] {
  const [, screen = '', arg = ''] = path.split('/')
  return [screen, arg]
}

export function useRoute(): [string, string] {
  const [path, setPath] = useState(() => location.pathname)
  useEffect(() => {
    const onMove = () => setPath(location.pathname)
    addEventListener('popstate', onMove)      // the back button
    addEventListener(MOVED, onMove)

    const onClick = (event: MouseEvent) => {
      // anything the browser should handle its own way is left alone
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = (event.target as Element | null)?.closest?.('a')
      if (!link || link.target || link.hasAttribute('download')) return
      const url = new URL(link.href)
      if (url.origin !== location.origin) return
      event.preventDefault()
      navigate(url.pathname)
    }
    addEventListener('click', onClick)
    return () => {
      removeEventListener('popstate', onMove)
      removeEventListener(MOVED, onMove)
      removeEventListener('click', onClick)
    }
  }, [])
  return routeOf(path)
}
