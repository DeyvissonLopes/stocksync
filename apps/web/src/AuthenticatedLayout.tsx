import type { ReactNode } from 'react';
import type { Identity } from './auth';

type AuthenticatedLayoutProps = {
  role: Identity['role'];
  activeView: 'products' | 'sales' | 'sync';
  onNavigate: (view: 'products' | 'sales' | 'sync') => void;
  isSigningOut: boolean;
  logoutError: string | null;
  onSignOut: () => void;
  children: ReactNode;
};

export function AuthenticatedLayout({
  role, activeView, onNavigate, isSigningOut, logoutError, onSignOut, children,
}: AuthenticatedLayoutProps) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-lg bg-slate-950 font-black text-teal-300">S</span>
            <span className="font-semibold tracking-tight">StockSync</span>
          </div>
          <div className="flex items-center gap-3 sm:gap-5">
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              Role: <span className="font-semibold text-slate-950">{role}</span>
            </span>
            <button
              type="button"
              onClick={onSignOut}
              disabled={isSigningOut}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-700 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
            >
              {isSigningOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
        <nav aria-label="Main navigation" className="mx-auto flex w-full max-w-6xl gap-1 px-6 sm:px-8">
          {(['products', 'sales', 'sync'] as const).map((view) => (
            <button
              key={view}
              type="button"
              aria-current={activeView === view ? 'page' : undefined}
              onClick={() => onNavigate(view)}
              className={`border-b-2 px-4 py-3 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-teal-700 focus:ring-inset ${activeView === view ? 'border-teal-700 text-teal-800' : 'border-transparent text-slate-600 hover:text-slate-950'}`}
            >
              {view === 'products' ? 'Products' : view === 'sales' ? 'Sales' : 'Sync'}
            </button>
          ))}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 py-8 sm:px-8">
        {logoutError && (
          <p role="alert" className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {logoutError}
          </p>
        )}
        {children}
      </main>
    </div>
  );
}
