import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { listProducts, ProductListError } from './products';
import type { ProductFilters, ProductPage } from './products';

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: ProductPage };

export function ProductsPage({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [page, setPage] = useState(1);
  const [draftName, setDraftName] = useState('');
  const [draftZeroStock, setDraftZeroStock] = useState(false);
  const [filters, setFilters] = useState<ProductFilters>({ name: '', zeroStock: false });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [result, setResult] = useState<LoadState>({ status: 'loading' });

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setFilters({ name: draftName.trim(), zeroStock: draftZeroStock });
  }

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult({ status: 'loading' });
    void listProducts(page, filters, controller.signal)
      .then((data) => {
        if (!active) return;
        if (page > 1 && data.products.length === 0 && page > data.pagination.totalPages) {
          setPage(Math.max(1, data.pagination.totalPages));
          return;
        }
        setResult({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ProductListError && error.kind === 'unauthorized') {
          onSessionExpired();
          return;
        }
        setResult({ status: 'error' });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [page, filters, loadAttempt, onSessionExpired]);

  return (
    <section aria-labelledby="products-heading" className="mt-8 border-t border-slate-200 pt-6">
      <div className="mb-6">
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-teal-700">Catalogue</p>
        <h2 id="products-heading" className="mt-2 text-xl font-semibold tracking-tight">Products</h2>
      </div>

      <form onSubmit={applyFilters} className="mb-6 flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="product-name-filter" className="mb-2 block text-sm font-medium text-slate-800">Search by name</label>
          <input
            id="product-name-filter"
            type="text"
            maxLength={100}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-950 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm font-medium text-slate-800">
          <input
            type="checkbox"
            checked={draftZeroStock}
            onChange={(event) => setDraftZeroStock(event.target.checked)}
            className="h-4 w-4 accent-teal-700"
          />
          Out of stock only
        </label>
        <button
          type="submit"
          className="rounded-lg bg-teal-700 px-4 py-2 font-semibold text-white transition hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-700 focus:ring-offset-2"
        >
          Apply filters
        </button>
      </form>

      {result.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">Loading products…</p>
      ) : result.status === 'error' ? (
        <div>
          <p role="alert" className="text-sm text-rose-800">Could not load products.</p>
          <button
            type="button"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            className="mt-4 rounded-xl border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-700 focus:ring-offset-2"
          >
            Try again
          </button>
        </div>
      ) : result.data.products.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-8 text-center text-sm text-slate-600">
          {filters.name || filters.zeroStock ? 'No products match these filters.' : 'No products yet.'}
        </p>
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {result.data.products.map((product) => (
              <li key={product.id} className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-950">{product.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{product.sku}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs text-slate-500">Price</p>
                    <p className="font-medium tabular-nums text-slate-800">{product.price}</p>
                  </div>
                </div>
                <p className={`mt-3 text-xs font-medium ${product.stock === 0 ? 'text-rose-700' : 'text-teal-700'}`}>
                  {product.stock === 0 ? 'Out of stock' : `${product.stock} in stock`}
                </p>
              </li>
            ))}
          </ul>
          {result.data.pagination.totalPages > 1 && (
            <nav aria-label="Product pages" className="mt-6 flex items-center justify-between gap-3">
              <button
                type="button"
                aria-label="Previous page"
                disabled={page === 1}
                onClick={() => setPage((current) => current - 1)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-sm tabular-nums text-slate-600">
                Page {result.data.pagination.page} of {result.data.pagination.totalPages}
              </span>
              <button
                type="button"
                aria-label="Next page"
                disabled={page >= result.data.pagination.totalPages}
                onClick={() => setPage((current) => current + 1)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
