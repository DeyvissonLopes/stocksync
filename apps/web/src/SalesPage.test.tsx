// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SalesPage } from './SalesPage';

const identity = {
  userId: '9b8ef3e1-a27c-4410-8463-74c9f8a68738',
  tenantId: '0562aa57-3d45-42e6-8549-28549fdb3aa3',
  role: 'admin' as const,
};
const product = {
  id: '9e588a34-7217-4d5b-a97a-c627ff6f4e48',
  name: 'Blue Mug', sku: 'DEMO-CAN', price: '29.90', stock: 8, version: '1',
};
const notebook = {
  id: 'e1048760-5839-4fc7-ae75-c876f61c31f5',
  name: 'A5 Notebook', sku: 'DEMO-NOTE', price: '15.90', stock: 6, version: '1',
};
const twoProductPage = () => new Response(JSON.stringify({
  products: [product, notebook],
  pagination: { page: 1, pageSize: 10, total: 2, totalPages: 1 },
}), { status: 200 });
const productPage = (stock = product.stock) => new Response(JSON.stringify({
  products: [{ ...product, stock }],
  pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
}), { status: 200 });
const saleResponse = () => new Response(JSON.stringify({
  sale: {
    id: 'b20fd33e-f5d2-4e8e-8b35-e5f4b4b6c365',
    createdAt: '2026-10-08T12:00:00.000Z',
    items: [{ productId: product.id, quantity: 2, unitPrice: '29.90' }],
  },
}), { status: 201 });
const key = 'a8b25d95-3a26-4290-a02e-c8f674940000';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('sale', () => {
  it('can select a product beyond the first catalogue page', async () => {
    const firstPage = new Response(JSON.stringify({
      products: Array.from({ length: 10 }, (_, index) => ({
        ...product, id: `product-${index + 1}`, name: `Product ${index + 1}`,
      })),
      pagination: { page: 1, pageSize: 10, total: 11, totalPages: 2 },
    }), { status: 200 });
    const secondPage = new Response(JSON.stringify({
      products: [product],
      pagination: { page: 2, pageSize: 10, total: 11, totalPages: 2 },
    }), { status: 200 });
    const fetchMock = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    vi.stubGlobal('fetch', fetchMock);

    render(<SalesPage identity={identity} onSessionExpired={vi.fn()} />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Select Product 1' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Select Blue Mug' }));

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/products?page=2', expect.any(Object));
    expect(screen.getByRole('spinbutton', { name: 'Quantity for Blue Mug' })).toBeInTheDocument();
  });

  it('submits a selected product with quantity and an idempotency key', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue(key) });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(productPage())
      .mockResolvedValueOnce(saleResponse())
      .mockResolvedValue(productPage());
    vi.stubGlobal('fetch', fetchMock);

    render(<SalesPage identity={identity} onSessionExpired={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select Blue Mug' }));
    const quantity = screen.getByRole('spinbutton', { name: 'Quantity for Blue Mug' });
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(screen.getByRole('button', { name: 'Record sale' }));

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/sales', {
      method: 'POST', credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-StockSync-Request': '1',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ items: [{ productId: product.id, quantity: 2 }] }),
    });
    expect(await screen.findByText(/Sale recorded/)).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it('records multiple products in one atomic sale request', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue(key) });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(twoProductPage())
      .mockResolvedValueOnce(saleResponse())
      .mockResolvedValue(twoProductPage());
    vi.stubGlobal('fetch', fetchMock);

    render(<SalesPage identity={identity} onSessionExpired={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select Blue Mug' }));
    await user.click(screen.getByRole('button', { name: 'Select A5 Notebook' }));
    expect(screen.getByRole('button', { name: 'Select Blue Mug' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Select A5 Notebook' })).toBeDisabled();
    await user.clear(screen.getByRole('spinbutton', { name: 'Quantity for Blue Mug' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Quantity for Blue Mug' }), '2');
    await user.clear(screen.getByRole('spinbutton', { name: 'Quantity for A5 Notebook' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Quantity for A5 Notebook' }), '3');
    await user.click(screen.getByRole('button', { name: 'Record sale' }));

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/sales', expect.objectContaining({
      headers: expect.objectContaining({ 'Idempotency-Key': key }),
      body: JSON.stringify({ items: [
        { productId: product.id, quantity: 2 },
        { productId: notebook.id, quantity: 3 },
      ] }),
    }));
    expect(await screen.findByText(/Sale recorded/)).toBeInTheDocument();
  });

  it('can remove a product before submitting the sale', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue(key) });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(twoProductPage())
      .mockResolvedValueOnce(saleResponse())
      .mockResolvedValue(twoProductPage());
    vi.stubGlobal('fetch', fetchMock);

    render(<SalesPage identity={identity} onSessionExpired={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select Blue Mug' }));
    await user.click(screen.getByRole('button', { name: 'Select A5 Notebook' }));
    await user.click(screen.getByRole('button', { name: 'Remove Blue Mug' }));
    expect(screen.queryByRole('spinbutton', { name: 'Quantity for Blue Mug' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record sale' }));

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/sales', expect.objectContaining({
      body: JSON.stringify({ items: [{ productId: notebook.id, quantity: 1 }] }),
    }));
  });

  it('restores an uncertain intent without automatic POST and retries with the same key', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue(key) });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(twoProductPage())
      .mockRejectedValueOnce(new TypeError('Network failure'))
      .mockResolvedValueOnce(twoProductPage())
      .mockResolvedValueOnce(saleResponse())
      .mockResolvedValue(twoProductPage());
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<SalesPage identity={identity} onSessionExpired={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Select Blue Mug' }));
    await user.click(screen.getByRole('button', { name: 'Select A5 Notebook' }));
    await user.clear(screen.getByRole('spinbutton', { name: 'Quantity for Blue Mug' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Quantity for Blue Mug' }), '2');
    await user.clear(screen.getByRole('spinbutton', { name: 'Quantity for A5 Notebook' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Quantity for A5 Notebook' }), '3');
    await user.click(screen.getByRole('button', { name: 'Record sale' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Sale status unknown');
    expect(screen.getByRole('spinbutton', { name: 'Quantity for Blue Mug' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Quantity for A5 Notebook' })).toBeDisabled();
    expect(sessionStorage.length).toBe(1);
    const firstPost = fetchMock.mock.calls[1];
    expect(JSON.parse(firstPost[1].body)).toEqual({ items: [
      { productId: product.id, quantity: 2 },
      { productId: notebook.id, quantity: 3 },
    ] });

    cleanup();
    render(<SalesPage identity={identity} onSessionExpired={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sale status unknown');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await user.click(screen.getByRole('button', { name: 'Retry sale' }));

    await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(4, firstPost[0], firstPost[1]));
    expect(await screen.findByText(/Sale recorded/)).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it('does not create another intent when the form is submitted twice before a response', async () => {
    let resolveSale!: (response: Response) => void;
    const saleRequest = new Promise<Response>((resolve) => { resolveSale = resolve; });
    const randomUUID = vi.fn().mockReturnValueOnce(key)
      .mockReturnValueOnce('24429231-968c-4bd5-ae4d-c082cbf93d97');
    vi.stubGlobal('crypto', { randomUUID });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(productPage())
      .mockReturnValueOnce(saleRequest)
      .mockResolvedValue(productPage());
    vi.stubGlobal('fetch', fetchMock);

    render(<SalesPage identity={identity} onSessionExpired={vi.fn()} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Select Blue Mug' }));
    const form = screen.getByRole('button', { name: 'Record sale' }).closest('form')!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    resolveSale(saleResponse());
    expect(await screen.findByText(/Sale recorded/)).toBeInTheDocument();
  });

  it('lets the user correct insufficient stock and submits a new intention', async () => {
    const secondKey = '24429231-968c-4bd5-ae4d-c082cbf93d97';
    vi.stubGlobal('crypto', { randomUUID: vi.fn()
      .mockReturnValueOnce(key).mockReturnValueOnce(secondKey) });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(twoProductPage())
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'INSUFFICIENT_STOCK' }), { status: 409 }))
      .mockResolvedValueOnce(twoProductPage())
      .mockResolvedValueOnce(saleResponse())
      .mockResolvedValue(twoProductPage());
    vi.stubGlobal('fetch', fetchMock);

    render(<SalesPage identity={identity} onSessionExpired={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select Blue Mug' }));
    await user.click(screen.getByRole('button', { name: 'Select A5 Notebook' }));
    const quantity = screen.getByRole('spinbutton', { name: 'Quantity for Blue Mug' });
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(screen.getByRole('button', { name: 'Record sale' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough stock');
    expect(screen.getByRole('alert')).toHaveTextContent('No items were sold');
    expect(quantity).toBeEnabled();
    expect(screen.getByRole('spinbutton', { name: 'Quantity for A5 Notebook' })).toHaveValue(1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await user.clear(quantity);
    await user.type(quantity, '1');
    await user.click(screen.getByRole('button', { name: 'Record sale' }));

    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/sales', expect.objectContaining({
      headers: expect.objectContaining({ 'Idempotency-Key': secondKey }),
      body: JSON.stringify({ items: [
        { productId: product.id, quantity: 1 },
        { productId: notebook.id, quantity: 1 },
      ] }),
    }));
    expect(await screen.findByText(/Sale recorded/)).toBeInTheDocument();
  });
});
