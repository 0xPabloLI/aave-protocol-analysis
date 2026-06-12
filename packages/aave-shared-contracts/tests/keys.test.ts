import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAddress,
  spokeKey,
  v4SpokeCacheKey,
  v3PriceKey,
  v4PriceKey,
  v3OnchainKey,
  v4OnchainKey,
  chainTokenKey,
  chainSymbolKey,
  topologySortKey,
  v4ReserveId,
  aaveProReserveId,
} from '../src/keys.js';

describe('normalizeAddress', () => {
  test('lowercases and trims address', () => {
    assert.equal(normalizeAddress('0xABCDEF'), '0xabcdef');
    assert.equal(normalizeAddress(' 0xABCDEF '), '0xabcdef');
  });

  test('equivalent to toLowerCase() for compliant addresses (no whitespace)', () => {
    const addr = '0x1234567890AbCdEf1234567890aBcDeF12345678';
    assert.equal(normalizeAddress(addr), addr.toLowerCase());
  });

  test('handles empty string', () => {
    assert.equal(normalizeAddress(''), '');
  });

  test('trims leading/trailing whitespace', () => {
    assert.equal(normalizeAddress('\t0xABC \n'), '0xabc');
  });
});

describe('spokeKey', () => {
  test('produces chainId:normalizedSpokeAddress format', () => {
    assert.equal(spokeKey(1, '0xABC'), '1:0xabc');
    assert.equal(spokeKey(42161, '0xDef'), '42161:0xdef');
  });

  test('different chainIds produce different keys', () => {
    assert.notEqual(spokeKey(1, '0xabc'), spokeKey(2, '0xabc'));
  });

  test('different spokeAddresses produce different keys', () => {
    assert.notEqual(spokeKey(1, '0xaaa'), spokeKey(1, '0xbbb'));
  });

  test('case-insensitive for spokeAddress', () => {
    assert.equal(spokeKey(1, '0xABC'), spokeKey(1, '0xabc'));
  });
});

describe('v4SpokeCacheKey', () => {
  test('produces normalizedSpoke:normalizedHub format', () => {
    assert.equal(v4SpokeCacheKey('0xSpoke', '0xHub'), '0xspoke:0xhub');
  });

  test('different spoke or hub addresses produce different keys', () => {
    assert.notEqual(v4SpokeCacheKey('0xA', '0xB'), v4SpokeCacheKey('0xA', '0xC'));
    assert.notEqual(v4SpokeCacheKey('0xA', '0xB'), v4SpokeCacheKey('0xD', '0xB'));
  });

  test('case-insensitive for both addresses', () => {
    assert.equal(v4SpokeCacheKey('0xSPOKE', '0xHUB'), v4SpokeCacheKey('0xspoke', '0xhub'));
  });
});

describe('v3PriceKey', () => {
  test('produces chainId:normalizedTokenAddress format', () => {
    assert.equal(v3PriceKey(1, '0xToken'), '1:0xtoken');
  });

  test('different chainIds or tokenAddresses produce different keys', () => {
    assert.notEqual(v3PriceKey(1, '0xA'), v3PriceKey(2, '0xA'));
    assert.notEqual(v3PriceKey(1, '0xA'), v3PriceKey(1, '0xB'));
  });

  test('lookup key matches write key format', () => {
    const writeKey = v3PriceKey(1, '0xABC');
    const lookupKey = v3PriceKey(1, '0xabc');
    assert.equal(writeKey, lookupKey);
  });
});

describe('v4PriceKey', () => {
  test('produces chainId:normalizedSpoke:normalizedToken format', () => {
    assert.equal(v4PriceKey(1, '0xSpoke', '0xToken'), '1:0xspoke:0xtoken');
  });

  test('different any-parameter produces different key', () => {
    const k1 = v4PriceKey(1, '0xA', '0xB');
    const k2 = v4PriceKey(2, '0xA', '0xB');
    const k3 = v4PriceKey(1, '0xC', '0xB');
    const k4 = v4PriceKey(1, '0xA', '0xD');
    assert.notEqual(k1, k2);
    assert.notEqual(k1, k3);
    assert.notEqual(k1, k4);
  });

  test('lookup key matches write key format (case-insensitive)', () => {
    const writeKey = v4PriceKey(1, '0xSPOKE', '0xTOKEN');
    const lookupKey = v4PriceKey(1, '0xspoke', '0xtoken');
    assert.equal(writeKey, lookupKey);
  });
});

describe('v3OnchainKey', () => {
  test('produces chainId:normalizedPool:normalizedToken format', () => {
    assert.equal(v3OnchainKey(1, '0xPool', '0xToken'), '1:0xpool:0xtoken');
  });

  test('different parameters produce different keys', () => {
    assert.notEqual(v3OnchainKey(1, '0xA', '0xB'), v3OnchainKey(2, '0xA', '0xB'));
    assert.notEqual(v3OnchainKey(1, '0xA', '0xB'), v3OnchainKey(1, '0xC', '0xB'));
    assert.notEqual(v3OnchainKey(1, '0xA', '0xB'), v3OnchainKey(1, '0xA', '0xD'));
  });

  test('poolAddress and tokenAddress are normalized', () => {
    const k1 = v3OnchainKey(1, '0xPOOL', '0xTOKEN');
    const k2 = v3OnchainKey(1, '0xpool', '0xtoken');
    assert.equal(k1, k2);
  });
});

describe('v4OnchainKey', () => {
  test('produces chainId:normalizedSpoke:normalizedToken:normalizedHub format', () => {
    assert.equal(v4OnchainKey(1, '0xSpoke', '0xToken', '0xHub'), '1:0xspoke:0xtoken:0xhub');
  });

  test('all address parameters are normalized', () => {
    const k1 = v4OnchainKey(1, '0xSPOKE', '0xTOKEN', '0xHUB');
    const k2 = v4OnchainKey(1, '0xspoke', '0xtoken', '0xhub');
    assert.equal(k1, k2);
  });

  test('consistent with v4ReserveId prefix (chainId:spoke:token:hub)', () => {
    const onchainKey = v4OnchainKey(1, '0xabc', '0xtoken', '0xdef');
    const reserveIdKey = v4ReserveId(1, '0xabc', '0xtoken', '0xdef');
    assert.equal(onchainKey, reserveIdKey);
  });
});

describe('chainTokenKey', () => {
  test('produces chainId:normalizedTokenAddress format', () => {
    assert.equal(chainTokenKey(1, '0xToken'), '1:0xtoken');
  });

  test('different parameters produce different keys', () => {
    assert.notEqual(chainTokenKey(1, '0xA'), chainTokenKey(2, '0xA'));
    assert.notEqual(chainTokenKey(1, '0xA'), chainTokenKey(1, '0xB'));
  });

  test('case-insensitive for tokenAddress', () => {
    assert.equal(chainTokenKey(1, '0xABC'), chainTokenKey(1, '0xabc'));
  });
});

describe('chainSymbolKey', () => {
  test('produces chainId:symbol format (no normalization)', () => {
    assert.equal(chainSymbolKey(1, 'USDC'), '1:USDC');
    assert.equal(chainSymbolKey(42161, 'ETH'), '42161:ETH');
  });

  test('different chainIds or symbols produce different keys', () => {
    assert.notEqual(chainSymbolKey(1, 'USDC'), chainSymbolKey(2, 'USDC'));
    assert.notEqual(chainSymbolKey(1, 'USDC'), chainSymbolKey(1, 'DAI'));
  });

  test('case-sensitive for symbol', () => {
    assert.notEqual(chainSymbolKey(1, 'USDC'), chainSymbolKey(1, 'usdc'));
  });
});

describe('topologySortKey', () => {
  test('produces chainId:normalizedSpoke:normalizedHub format', () => {
    assert.equal(topologySortKey(1, '0xSpoke', '0xHub'), '1:0xspoke:0xhub');
  });

  test('consistent with v4-topology seen set format', () => {
    const chainId = 1;
    const spokeAddress = '0xabc';
    const hubAddress = '0xdef';
    const inlineKey = `${chainId}:${spokeAddress}:${hubAddress}`;
    const namedKey = topologySortKey(chainId, spokeAddress, hubAddress);
    assert.equal(namedKey, inlineKey);
  });
});

describe('v4ReserveId', () => {
  test('produces chainId:normalizedSpoke:normalizedToken:normalizedHub format', () => {
    assert.equal(v4ReserveId(1, '0xSpoke', '0xToken', '0xHub'), '1:0xspoke:0xtoken:0xhub');
  });

  test('different any-parameter produces different key', () => {
    const k1 = v4ReserveId(1, '0xA', '0xB', '0xC');
    const k2 = v4ReserveId(2, '0xA', '0xB', '0xC');
    const k3 = v4ReserveId(1, '0xD', '0xB', '0xC');
    const k4 = v4ReserveId(1, '0xA', '0xE', '0xC');
    const k5 = v4ReserveId(1, '0xA', '0xB', '0xF');
    assert.notEqual(k1, k2);
    assert.notEqual(k1, k3);
    assert.notEqual(k1, k4);
    assert.notEqual(k1, k5);
  });

  test('consistent with onchainDataService V4 lookup key format', () => {
    const reserveId = v4ReserveId(1, '0xspoke', '0xtoken', '0xhub');
    const onchainKey = v4OnchainKey(1, '0xspoke', '0xtoken', '0xhub');
    assert.equal(reserveId, onchainKey);
  });
});

describe('aaveProReserveId', () => {
  test('produces chainId:normalizedSpoke:normalizedUnderlying:normalizedHub:hubName format', () => {
    assert.equal(
      aaveProReserveId(1, '0xSpoke', '0xUnderlying', '0xHub', 'Main'),
      '1:0xspoke:0xunderlying:0xhub:Main',
    );
  });

  test('spokeAddress, underlying, and hubAddress are normalized', () => {
    const k1 = aaveProReserveId(1, '0xSPOKE', '0xUNDERLYING', '0xHUB', 'Main');
    const k2 = aaveProReserveId(1, '0xspoke', '0xunderlying', '0xhub', 'Main');
    assert.equal(k1, k2);
  });

  test('different hubNames produce different keys', () => {
    const k1 = aaveProReserveId(1, '0xabc', '0xunder', '0xhub', 'Main');
    const k2 = aaveProReserveId(1, '0xabc', '0xunder', '0xhub', 'Backup');
    assert.notEqual(k1, k2);
  });
});
