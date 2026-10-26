import { describe, expect, it } from 'vitest';
import { buildBurnTokenRequest } from '../src/transaction.js';
import { MinterConnectError } from '../src/types.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof MinterConnectError ? e.code : 'other';
  }
  return 'no error';
};

describe('buildBurnTokenRequest', () => {
  it('builds the v1 burnToken request with exactly amount and coin', () => {
    expect(buildBurnTokenRequest({ amount: '1.5', coin: 'DECIMINTER' })).toEqual({
      v: 1,
      method: 'burnToken',
      params: { amount: '1.5', coin: 'DECIMINTER' },
    });
  });

  it('rejects extra fields, including a recipient', () => {
    expect(code(() => buildBurnTokenRequest({ amount: '1', coin: 'BIP', to: 'Mx' } as never))).toBe('invalid_request');
  });

  it('applies the transfer rules to amount and coin', () => {
    for (const amount of ['0', '0.0', '-1', '1e3', ' 1', '1.0000000000000000001']) {
      expect(code(() => buildBurnTokenRequest({ amount, coin: 'BIP' }))).toBe('invalid_request');
    }
    for (const coin of ['bip', 'AB', 'TOOLONGTICKER', 'BI P']) {
      expect(code(() => buildBurnTokenRequest({ amount: '1', coin }))).toBe('invalid_request');
    }
  });
});
