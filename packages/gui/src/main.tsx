/**
 * The shell. TanStack Router with code-based routes — there are ten of them and they are
 * all one component with one prop, so a file-based tree and its generated route file would
 * be machinery around nothing.
 *
 * The project comes from the daemon's boot block, and `?project=` overrides it. That is the
 * whole project switcher: 08-projects-config.md's rule is that the resolved project is
 * always visible, not that the GUI owns the resolution.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider, useNavigate, useSearch } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { boot } from './api.ts';
import { Corpus } from './pages/corpus.tsx';
import { Dashboard } from './pages/dashboard.tsx';
import { Feed } from './pages/feed.tsx';
import { Issues } from './pages/issues.tsx';
import { Panels } from './pages/panels.tsx';
import { Profiles } from './pages/profiles.tsx';
import { Seal } from './pages/seal.tsx';
import { Services } from './pages/services.tsx';
import { State } from './pages/state.tsx';
import { Urls } from './pages/urls.tsx';
import './styles.css';

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/feed', label: 'Feed' },
  { to: '/issues', label: 'Issues' },
  { to: '/urls', label: 'Addresses' },
  { to: '/profiles', label: 'Profiles' },
  { to: '/services', label: 'Services' },
  { to: '/corpus', label: 'Corpus' },
  { to: '/state', label: 'State' },
  { to: '/seal', label: 'Seal' },
  { to: '/panels', label: 'Panels' },
] as const;

interface Search {
  project?: string;
}

const rootRoute = createRootRoute({
  validateSearch: (search: Record<string, unknown>): Search => ({
    project: typeof search.project === 'string' ? search.project : undefined,
  }),
  component: Chrome,
});

function useProject(): string {
  return useSearch({ from: rootRoute.id }).project ?? boot.project;
}

function Chrome() {
  const project = useProject();
  const navigate = useNavigate();

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-2 border-b border-line px-4 py-2">
        <span className="font-medium">mocktown</span>
        <nav className="flex flex-wrap gap-3">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              search={{ project }}
              className="text-muted hover:text-ink [&.active]:text-ink [&.active]:underline"
              activeOptions={{ exact: item.to === '/' }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <label className="ml-auto flex items-center gap-2">
          <span className="text-muted">project</span>
          <input
            className="w-40 rounded border border-line bg-raised px-1 py-0.5 font-mono"
            defaultValue={project}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              const next = (event.target as HTMLInputElement).value.trim();
              if (next) navigate({ to: '.', search: { project: next } });
            }}
          />
        </label>
      </header>
      <main className="p-4">
        <Outlet />
      </main>
    </div>
  );
}

/** One route per page, each handed the resolved project. */
const page = <Path extends string>(path: Path, render: (props: { project: string }) => React.ReactNode) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => render({ project: useProject() }),
  });

const routeTree = rootRoute.addChildren([
  page('/', Dashboard),
  page('/feed', Feed),
  page('/issues', Issues),
  page('/urls', Urls),
  page('/profiles', Profiles),
  page('/services', Services),
  page('/corpus', Corpus),
  page('/state', State),
  page('/seal', Seal),
  page('/panels', Panels),
]);

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// One retry and no window-focus refetching: this is a local daemon, so a failure is a real
// failure worth showing rather than a network blip worth papering over.
const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
