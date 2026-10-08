import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AuthRequestError, currentSession, login, logout } from './auth';
import type { Identity } from './auth';
import { AuthenticatedLayout } from './AuthenticatedLayout';
import { ProductsPage } from './ProductsPage';
import { hasPendingSaleIntent, SalesPage } from './SalesPage';

type SessionState =
  | { status: 'checking' | 'anonymous' | 'error' }
  | { status: 'authenticated'; user: Identity };

function errorMessage(error: unknown): string {
  if (error instanceof AuthRequestError) {
    if (error.kind === 'invalid') return 'Incorrect email or password.';
    if (error.kind === 'rate-limited') return 'Too many sign-in attempts. Try again shortly.';
  }
  return 'Could not sign in. Try again.';
}

export function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [session, setSession] = useState<SessionState>({ status: 'checking' });
  const [sessionCheckAttempt, setSessionCheckAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [view, setView] = useState<'products' | 'sales'>('products');
  const handleSessionExpired = useCallback(() => {
    setEmail('');
    setPassword('');
    setView('products');
    setSession({ status: 'anonymous' });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void currentSession(controller.signal)
      .then((user) => {
        if (!active) return;
        setView(user && hasPendingSaleIntent(user) ? 'sales' : 'products');
        setSession(user ? { status: 'authenticated', user } : { status: 'anonymous' });
      })
      .catch(() => {
        if (active) setSession({ status: 'error' });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [sessionCheckAttempt]);

  useEffect(() => {
    if (session.status === 'authenticated') window.scrollTo(0, 0);
  }, [session.status, view]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const user = await login(email, password);
      setPassword('');
      setView(hasPendingSaleIntent(user) ? 'sales' : 'products');
      setSession({ status: 'authenticated', user });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLogout() {
    if (isSigningOut) return;
    setLogoutError(null);
    setIsSigningOut(true);
    try {
      await logout();
      setEmail('');
      setPassword('');
      setView('products');
      setSession({ status: 'anonymous' });
    } catch {
      setLogoutError('Could not sign out. Try again.');
    } finally {
      setIsSigningOut(false);
    }
  }

  if (session.status === 'authenticated') {
    return (
      <AuthenticatedLayout
        role={session.user.role}
        activeView={view}
        onNavigate={setView}
        isSigningOut={isSigningOut}
        logoutError={logoutError}
        onSignOut={handleLogout}
      >
        {view === 'products' ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Inventory dashboard</h1>
            <ProductsPage onSessionExpired={handleSessionExpired} />
          </>
        ) : (
          <SalesPage identity={session.user} onSessionExpired={handleSessionExpired} />
        )}
      </AuthenticatedLayout>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950 lg:grid lg:grid-cols-2">
      <section className="relative flex flex-col justify-between overflow-hidden bg-slate-950 px-8 py-10 text-white sm:px-12 lg:min-h-screen lg:px-16 lg:py-14">
        <div aria-hidden="true" className="absolute -right-24 top-24 h-80 w-80 rounded-full border border-teal-300/20" />
        <div aria-hidden="true" className="absolute -right-8 top-40 h-80 w-80 rounded-full border border-teal-300/10" />
        <div className="relative flex items-center gap-3">
          <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-xl bg-teal-300 text-lg font-black text-slate-950">S</span>
          <span className="text-lg font-semibold tracking-tight">StockSync</span>
        </div>
        <div className="relative mt-20 max-w-lg lg:mt-0">
          <p className="mb-5 text-xs font-bold uppercase tracking-[0.28em] text-teal-300">Inventory workspace</p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Keep every product, sale, and update in view.
          </h1>
          <p className="mt-6 max-w-md text-base leading-relaxed text-slate-300">
            A clear place to manage stock and follow what happens next.
          </p>
        </div>
        <p className="relative mt-16 text-sm text-slate-400 lg:mt-0">StockSync</p>
      </section>

      <section className="flex min-h-[60vh] items-center justify-center px-6 py-14 sm:px-12 lg:px-16">
        <div className="w-full max-w-md">
          {session.status === 'checking' ? (
            <div role="status" aria-live="polite" className="text-slate-600">
              Checking session…
            </div>
          ) : session.status === 'error' ? (
            <div>
              <p role="alert" className="text-slate-700">Could not check your session.</p>
              <button
                type="button"
                onClick={() => {
                  setSession({ status: 'checking' });
                  setSessionCheckAttempt((attempt) => attempt + 1);
                }}
                className="mt-5 rounded-xl bg-teal-700 px-5 py-3 font-semibold text-white focus:outline-none focus:ring-2 focus:ring-teal-700 focus:ring-offset-2"
              >
                Try again
              </button>
            </div>
          ) : (
            <>
              <p className="mb-3 text-xs font-bold uppercase tracking-[0.24em] text-teal-700">Account access</p>
              <h2 className="text-3xl font-semibold tracking-tight">Sign in to StockSync</h2>
              <p className="mt-3 text-slate-600">Enter your account details to continue.</p>

              <form className="mt-10 space-y-5" onSubmit={handleSubmit}>
                <div>
                  <label htmlFor="email" className="mb-2 block text-sm font-medium text-slate-800">Email</label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    aria-describedby={error ? 'login-error' : undefined}
                    className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-950 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
                  />
                </div>
                <div>
                  <label htmlFor="password" className="mb-2 block text-sm font-medium text-slate-800">Password</label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-describedby={error ? 'login-error' : undefined}
                    className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-950 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
                  />
                </div>
                {error && (
                  <p id="login-error" role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                    {error}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full rounded-xl bg-teal-700 px-4 py-3 font-semibold text-white transition hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-700 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
                >
                  {isSubmitting ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
