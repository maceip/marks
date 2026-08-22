import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'document'; id: string }
  | { name: 'benchmark' };

function parse(pathname: string): Route {
  const document = /^\/d\/([\w-]{1,64})$/.exec(pathname);
  if (document) return { name: 'document', id: document[1] };
  if (pathname === '/bench') return { name: 'benchmark' };
  return { name: 'home' };
}

export function routeToPath(route: Route): string {
  switch (route.name) {
    case 'document':
      return `/d/${route.id}`;
    case 'benchmark':
      return '/bench';
    default:
      return '/';
  }
}

/** A router small enough not to need a router. */
export function useRoute(): [Route, (route: Route, options?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(() => parse(location.pathname));

  useEffect(() => {
    const onPopState = () => setRoute(parse(location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    const path = routeToPath(next);
    if (path !== location.pathname) {
      history[options?.replace ? 'replaceState' : 'pushState']({}, '', `${path}${location.search}`);
    }
    setRoute(next);
  }, []);

  return [route, navigate];
}
