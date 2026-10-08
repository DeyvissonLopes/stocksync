// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductsPage } from './ProductsPage';

const product = (number: number) => ({
  id: `product-${number}`,
  sku: `SKU-${number}`,
  name: number === 1 ? 'Blue Mug' : `Product ${number}`,
  price: number === 1 ? '19.90' : '12.50',
  stock: number === 1 ? 0 : number,
  version: '1',
});
const firstPage = {
  products: Array.from({ length: 10 }, (_, index) => product(index + 1)),
  pagination: { page: 1, pageSize: 10, total: 11, totalPages: 2 },
};
const secondPage = {
  products: [product(11)],
  pagination: { page: 2, pageSize: 10, total: 11, totalPages: 2 },
};
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('authenticated product catalogue', () => {
  it('loads page one with the session cookie and displays product fields', async () => {
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ProductsPage onSessionExpired={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading products…');
    expect(fetchMock).toHaveBeenCalledWith('/api/products?page=1', expect.objectContaining({
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    }));
    resolveRequest(jsonResponse(firstPage));
    expect(await screen.findByText('Blue Mug')).toBeInTheDocument();
    expect(screen.getByText('SKU-1')).toBeInTheDocument();
    expect(screen.getByText('19.90')).toBeInTheDocument();
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });

  it('moves between pages using the API pagination result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage))
      .mockResolvedValueOnce(jsonResponse(firstPage));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<ProductsPage onSessionExpired={vi.fn()} />);
    await screen.findByText('Blue Mug');
    await user.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByText('Product 11')).toBeInTheDocument();
    expect(screen.queryByText('Blue Mug')).not.toBeInTheDocument();
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/products?page=2', expect.any(Object));

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('Blue Mug')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/products?page=1', expect.any(Object));
  });

  it('returns to the last valid page when the catalogue shrinks', async () => {
    const reducedFirstPage = {
      products: firstPage.products,
      pagination: { page: 1, pageSize: 10, total: 10, totalPages: 1 },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse({
        products: [], pagination: { page: 2, pageSize: 10, total: 10, totalPages: 1 },
      }))
      .mockResolvedValueOnce(jsonResponse(reducedFirstPage));
    vi.stubGlobal('fetch', fetchMock);

    render(<ProductsPage onSessionExpired={vi.fn()} />);
    await screen.findByText('Blue Mug');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByText('Blue Mug')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/products?page=1', expect.any(Object));
    expect(screen.queryByText('No products yet.')).not.toBeInTheDocument();
  });

  it('shows an empty state without page navigation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      products: [], pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 },
    })));

    render(<ProductsPage onSessionExpired={vi.fn()} />);

    expect(await screen.findByText('No products yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('offers a retry after a temporary API failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(firstPage));
    vi.stubGlobal('fetch', fetchMock);

    render(<ProductsPage onSessionExpired={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load products.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Blue Mug')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops old products and reports a session that expires during pagination', async () => {
    const onSessionExpired = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ProductsPage onSessionExpired={onSessionExpired} />);
    await screen.findByText('Blue Mug');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Blue Mug')).not.toBeInTheDocument();
  });
});
