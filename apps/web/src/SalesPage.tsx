import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Identity } from './auth';
import { listProducts, ProductListError } from './products';
import type { Product, ProductPage } from './products';
import { createSale, SaleRequestError } from './sales';

type CatalogueState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: ProductPage };
type SaleLine = { product: Product; quantity: string };
type SaleIntent = { key: string; items: Array<{ product: Product; quantity: number }> };
type Message = { kind: 'success' | 'error'; text: string };

function intentStorageKey(identity: Identity): string {
  return `stocksync:sale-intent:${identity.tenantId}:${identity.userId}`;
}

function readIntent(key: string): SaleIntent | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SaleIntent> | null;
    const items = value?.items;
    if (typeof value?.key === 'string' && Array.isArray(items) &&
      items.length >= 1 && items.length <= 100 &&
      items.every((item) => item && item.product &&
        typeof item.product.id === 'string' && typeof item.product.name === 'string' &&
        typeof item.product.sku === 'string' && typeof item.product.stock === 'number' &&
        Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 2147483647) &&
      new Set(items.map((item) => item.product.id)).size === items.length) {
      return value as SaleIntent;
    }
    sessionStorage.removeItem(key);
  } catch { /* Corrupt or unavailable browser storage cannot restore an intent. */ }
  return null;
}

export function hasPendingSaleIntent(identity: Identity): boolean {
  return readIntent(intentStorageKey(identity)) !== null;
}

function clearIntent(key: string) {
  try { sessionStorage.removeItem(key); } catch { /* The UI still shows the response. */ }
}

function definiteError(error: SaleRequestError): string {
  if (error.kind === 'insufficient-stock') return 'Not enough stock. No items were sold. Adjust quantities and try again.';
  if (error.kind === 'unavailable-product') return 'A product is no longer available. No items were sold.';
  return 'Could not record this sale. Review the items and try again.';
}

export function SalesPage({ identity, onSessionExpired }: {
  identity: Identity; onSessionExpired: () => void;
}) {
  const storageKey = intentStorageKey(identity);
  const [pending, setPending] = useState<SaleIntent | null>(() => readIntent(storageKey));
  const [phase, setPhase] = useState<'idle' | 'sending' | 'uncertain'>(pending ? 'uncertain' : 'idle');
  const [message, setMessage] = useState<Message | null>(null);
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [searchName, setSearchName] = useState('');
  const [page, setPage] = useState(1);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [catalogue, setCatalogue] = useState<CatalogueState>({ status: 'loading' });
  const requestInFlight = useRef(false);
  const visibleLines = pending?.items.map((item) => ({
    product: item.product, quantity: String(item.quantity),
  })) ?? lines;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setCatalogue({ status: 'loading' });
    void listProducts(page, { name: searchName, zeroStock: false }, controller.signal)
      .then((data) => {
        if (!active) return;
        if (page > 1 && data.products.length === 0 && page > data.pagination.totalPages) {
          setPage(Math.max(1, data.pagination.totalPages));
          return;
        }
        setCatalogue({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ProductListError && error.kind === 'unauthorized') {
          onSessionExpired();
          return;
        }
        setCatalogue({ status: 'error' });
      });
    return () => { active = false; controller.abort(); };
  }, [page, searchName, loadAttempt, onSessionExpired]);

  async function sendIntent(intent: SaleIntent) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setPhase('sending');
    setMessage(null);
    try {
      const sale = await createSale(intent.key, intent.items.map((item) => ({
        productId: item.product.id, quantity: item.quantity,
      })));
      clearIntent(storageKey);
      setPending(null);
      setLines([]);
      setPhase('idle');
      setMessage({ kind: 'success', text: `Sale recorded. ID: ${sale.id}` });
      setLoadAttempt((attempt) => attempt + 1);
    } catch (error) {
      if (error instanceof SaleRequestError && error.kind === 'unauthorized') {
        clearIntent(storageKey);
        onSessionExpired();
        return;
      }
      if (error instanceof SaleRequestError && error.kind !== 'unknown') {
        clearIntent(storageKey);
        setPending(null);
        setLines(intent.items.map((item) => ({
          product: item.product, quantity: String(item.quantity),
        })));
        setPhase('idle');
        setMessage({ kind: 'error', text: definiteError(error) });
        setLoadAttempt((attempt) => attempt + 1);
        return;
      }
      setPhase('uncertain');
    } finally {
      requestInFlight.current = false;
    }
  }

  function recordSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lines.length === 0 || lines.length > 100 || phase !== 'idle' || requestInFlight.current) return;
    const items = lines.map((line) => ({ product: line.product, quantity: Number(line.quantity) }));
    if (items.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 2147483647)) {
      setMessage({ kind: 'error', text: 'Enter a positive whole-number quantity.' });
      return;
    }
    const intent = { key: crypto.randomUUID(), items };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(intent));
    } catch {
      setMessage({ kind: 'error', text: 'Could not save this sale for a safe retry.' });
      return;
    }
    setPending(intent);
    void sendIntent(intent);
  }

  function searchProducts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearchName(searchInput.trim());
  }

  return (
    <section aria-labelledby="sale-heading">
      <h1 id="sale-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">New sale</h1>
      <p className="mt-2 text-sm text-slate-600">Choose products and enter the quantity for each one.</p>

      {phase === 'uncertain' && (
        <div role="alert" className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <p>Sale status unknown. Retry the same request to confirm the result.</p>
          <button type="button" onClick={() => { if (pending) void sendIntent(pending); }} className="mt-3 rounded-lg bg-amber-900 px-4 py-2 font-semibold text-white focus:outline-none focus:ring-2 focus:ring-amber-900 focus:ring-offset-2">
            Retry sale
          </button>
        </div>
      )}
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`mt-6 rounded-xl border px-4 py-3 text-sm ${message.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-teal-200 bg-teal-50 text-teal-900'}`}>
          {message.text}
        </p>
      )}

      {visibleLines.length > 0 && (
        <form onSubmit={recordSale} className="mt-6 max-w-xl rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-slate-950">Sale items ({visibleLines.length})</h2>
          <ul className="mt-4 divide-y divide-slate-200">
            {visibleLines.map(({ product, quantity }) => (
              <li key={product.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-950">{product.name}</p>
                    <p className="text-sm text-slate-600">{product.sku}</p>
                  </div>
                  {phase === 'idle' && (
                    <button type="button" aria-label={`Remove ${product.name}`}
                      onClick={() => setLines((current) => current.filter((line) => line.product.id !== product.id))}
                      className="text-sm font-semibold text-rose-700 underline focus:outline-none focus:ring-2 focus:ring-rose-700">
                      Remove
                    </button>
                  )}
                </div>
                <label htmlFor={`sale-quantity-${product.id}`} className="mt-3 block text-sm font-medium text-slate-800">Quantity for {product.name}</label>
                <input id={`sale-quantity-${product.id}`} type="number" min="1" max="2147483647" step="1" required
                  disabled={phase !== 'idle'} value={quantity}
                  onChange={(event) => setLines((current) => current.map((line) =>
                    line.product.id === product.id ? { ...line, quantity: event.target.value } : line))}
                  className="mt-2 w-32 rounded-lg border border-slate-300 px-3 py-2 text-slate-950 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20 disabled:bg-slate-100" />
              </li>
            ))}
          </ul>
          {phase === 'idle' && (
            <button type="submit" className="mt-5 block rounded-lg bg-teal-700 px-5 py-2 font-semibold text-white focus:outline-none focus:ring-2 focus:ring-teal-700 focus:ring-offset-2">
              Record sale
            </button>
          )}
          {phase === 'sending' && <p role="status" className="mt-5 text-sm text-slate-600">Recording sale…</p>}
        </form>
      )}

      <div className="mt-10 border-t border-slate-200 pt-6">
        <h2 className="text-xl font-semibold tracking-tight">Find a product</h2>
        <form onSubmit={searchProducts} className="mt-4 flex max-w-xl flex-col gap-3 sm:flex-row">
          <label htmlFor="sale-product-search" className="sr-only">Find product by name</label>
          <input id="sale-product-search" type="text" maxLength={100} disabled={phase !== 'idle'}
            value={searchInput} onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search by name"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-950 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20" />
          <button type="submit" disabled={phase !== 'idle'} className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-700 focus:ring-offset-2 disabled:opacity-50">Search</button>
        </form>

        {catalogue.status === 'loading' ? (
          <p role="status" className="mt-5 text-sm text-slate-600">Loading products…</p>
        ) : catalogue.status === 'error' ? (
          <div className="mt-5">
            <p role="alert" className="text-sm text-rose-800">Could not load products.</p>
            <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)} className="mt-3 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold">Try again</button>
          </div>
        ) : catalogue.data.products.length === 0 ? (
          <p className="mt-5 text-sm text-slate-600">No products found.</p>
        ) : (
          <>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {catalogue.data.products.map((product) => (
                <li key={product.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{product.name}</p>
                    <p className="text-xs text-slate-600">{product.sku} · {product.stock} in stock</p>
                  </div>
                  <button type="button" aria-label={`Select ${product.name}`}
                    disabled={phase !== 'idle' || product.stock === 0 || lines.length >= 100 ||
                      lines.some((line) => line.product.id === product.id)}
                    onClick={() => {
                      setLines((current) => current.length >= 100 ||
                        current.some((line) => line.product.id === product.id)
                        ? current : [...current, { product, quantity: '1' }]);
                      setMessage(null);
                    }}
                    className="rounded-lg border border-teal-700 px-3 py-2 text-sm font-semibold text-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-700 disabled:border-slate-300 disabled:text-slate-400">
                    Select
                  </button>
                </li>
              ))}
            </ul>
            {catalogue.data.pagination.totalPages > 1 && (
              <nav aria-label="Sale product pages" className="mt-5 flex items-center justify-between gap-3">
                <button type="button" disabled={page === 1 || phase !== 'idle'} onClick={() => setPage((value) => value - 1)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-50">Previous</button>
                <span className="text-sm text-slate-600">Page {page} of {catalogue.data.pagination.totalPages}</span>
                <button type="button" disabled={page >= catalogue.data.pagination.totalPages || phase !== 'idle'} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-50">Next</button>
              </nav>
            )}
          </>
        )}
      </div>
    </section>
  );
}
