import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { prepareSaleRequest } from '../src/sales/sale-request.js';

const productA = '10000000-0000-4000-8000-000000000001';
const productB = '20000000-0000-4000-8000-000000000002';
const userA = '30000000-0000-4000-8000-000000000003';
const userB = '40000000-0000-4000-8000-000000000004';
const key = '50000000-0000-4000-8000-000000000005';

describe('sale request preparation', () => {
  it('aggregates repeated products and sorts them before hashing', () => {
    const first = prepareSaleRequest(key.toUpperCase(), { items: [
      { productId: productB, quantity: 2 },
      { productId: productA, quantity: 1 },
      { productId: productB.toUpperCase(), quantity: 3 },
    ] }, userA);
    const equivalent = prepareSaleRequest(key, { items: [
      { productId: productA, quantity: 1 },
      { productId: productB, quantity: 5 },
    ] }, userA);

    expect(first).toEqual(equivalent);
    expect(first).toMatchObject({
      idempotencyKey: key,
      items: [
        { productId: productA, quantity: 1 },
        { productId: productB, quantity: 5 },
      ],
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('changes the hash for another quantity, product or authenticated actor', () => {
    const original = prepareSaleRequest(key, { items: [
      { productId: productA, quantity: 1 },
    ] }, userA);
    const changedQuantity = prepareSaleRequest(key, { items: [
      { productId: productA, quantity: 2 },
    ] }, userA);
    const changedProduct = prepareSaleRequest(key, { items: [
      { productId: productB, quantity: 1 },
    ] }, userA);
    const changedActor = prepareSaleRequest(key, { items: [
      { productId: productA, quantity: 1 },
    ] }, userB);

    expect(new Set([original.requestHash, changedQuantity.requestHash,
      changedProduct.requestHash, changedActor.requestHash]).size).toBe(4);
  });

  it.each([undefined, '', 'not-a-uuid', '50000000-0000-1000-8000-000000000005',
    [key], `${key} `])('rejects an invalid idempotency key: %s', (invalidKey) => {
    expect(() => prepareSaleRequest(invalidKey, { items: [
      { productId: productA, quantity: 1 },
    ] }, userA)).toThrow(BadRequestException);
  });

  it.each([
    null,
    [],
    {},
    { items: [], extra: true },
    { items: [] },
    { items: 'invalid' },
    { items: Array.from({ length: 101 }, () => ({ productId: productA, quantity: 1 })) },
    { items: [{ productId: productA, quantity: 1, price: '1.00' }] },
    { items: [{ productId: 'invalid', quantity: 1 }] },
    { items: [{ productId: productA, quantity: 0 }] },
    { items: [{ productId: productA, quantity: -1 }] },
    { items: [{ productId: productA, quantity: 1.5 }] },
    { items: [{ productId: productA, quantity: 2147483648 }] },
    { items: [
      { productId: productA, quantity: 2147483647 },
      { productId: productA, quantity: 1 },
    ] },
  ])('rejects an invalid sale body: %#', (body) => {
    expect(() => prepareSaleRequest(key, body, userA)).toThrow(BadRequestException);
  });
});
