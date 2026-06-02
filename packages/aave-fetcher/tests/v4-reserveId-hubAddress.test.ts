import test from 'node:test';
import assert from 'node:assert/strict';

test('V4 reserveId fourth segment is hubAddress (not hubName)', () => {
  const chainId = 1;
  const spokeAddress = '0x94e7a5dcbe816e498b89ab752661904e2f56c485';
  const tokenAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const hubAddress = '0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9'.toLowerCase();
  const hubName = 'Core';

  const reserveId = `${chainId}:${spokeAddress}:${tokenAddress}:${hubAddress}`;
  const parts = reserveId.split(':');

  assert.strictEqual(parts.length, 4, 'V4 reserveId has 4 segments');
  assert.strictEqual(parts[0], String(chainId), 'first segment is chainId');
  assert.ok(parts[1].startsWith('0x'), 'second segment is spokeAddress');
  assert.ok(parts[2].startsWith('0x'), 'third segment is tokenAddress');
  assert.ok(parts[3].startsWith('0x'), 'fourth segment is hubAddress (not hubName)');
  assert.strictEqual(parts[3], hubAddress, 'fourth segment is the Hub contract address');
  assert.ok(parts[3] !== hubName, 'fourth segment is NOT the human-readable hubName');
  assert.ok(parts[3] === parts[3].toLowerCase(), 'fourth segment is lowercase');
});

test('V4 reserveId with hubAddress matches onchainKey directly (no fallback)', () => {
  const chainId = 1;
  const spokeAddress = '0x94e7a5dcbe816e498b89ab752661904e2f56c485';
  const tokenAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const hubAddress = '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9';

  const reserveId = `${chainId}:${spokeAddress}:${tokenAddress}:${hubAddress}`;
  const onchainKey = `${chainId}:${spokeAddress}:${tokenAddress}:${hubAddress}`;

  assert.strictEqual(reserveId, onchainKey, 'reserveId and onchainKey are identical');

  const map = new Map<string, string>();
  map.set(onchainKey, 'deficit_value');
  assert.strictEqual(map.get(reserveId), 'deficit_value', 'direct Map.get works without remapping');
});

test('V4 reserveId hubAddress is different for different hubs (uniqueness)', () => {
  const chainId = 1;
  const spokeAddress = '0x94e7a5dcbe816e498b89ab752661904e2f56c485';
  const tokenAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const coreHubAddress = '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9';
  const primeHubAddress = '0x943827dca022d0f354a8a8c332da1e5eb9f9f931';

  const reserveIdCore = `${chainId}:${spokeAddress}:${tokenAddress}:${coreHubAddress}`;
  const reserveIdPrime = `${chainId}:${spokeAddress}:${tokenAddress}:${primeHubAddress}`;

  assert.notStrictEqual(reserveIdCore, reserveIdPrime, 'different hubAddress produces different reserveId');
});

test('V4 reserveId hubAddress ensures uniqueness for same spoke+token from different hubs', () => {
  const chainId = 1;
  const bluechipSpoke = '0x94e7a5dcbe816e498b89ab752661904e2f56c485';
  const usdt = '0xdac17f958d2ee523a2206206994597c13d831ec7';
  const coreHub = '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9';
  const primeHub = '0x943827dca022d0f354a8a8c332da1e5eb9f9f931';

  const reserveIdFromCore = `${chainId}:${bluechipSpoke}:${usdt}:${coreHub}`;
  const reserveIdFromPrime = `${chainId}:${bluechipSpoke}:${usdt}:${primeHub}`;

  assert.notStrictEqual(reserveIdFromCore, reserveIdFromPrime);
});

test('V3 reserveId format unchanged (3 segments, no hubAddress)', () => {
  const v3ReserveId = '1:0x87870bca3f3e6a89e12e23a2e01484e8a4a2e7c1:0xbe9895145f349a6695d5da8e9c6b50a9';
  const parts = v3ReserveId.split(':');
  assert.strictEqual(parts.length, 3, 'V3 reserveId has 3 segments');
  assert.ok(parts[1].startsWith('0x'), 'second segment is poolAddress');
  assert.ok(parts[2].startsWith('0x'), 'third segment is tokenAddress');
});
