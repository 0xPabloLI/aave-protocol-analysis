import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const README_URL =
  process.env.AAVE_SUBGRAPH_README_URL ||
  'https://raw.githubusercontent.com/aave/protocol-subgraphs/master/README.md';
const LOCAL_README_PATH =
  process.env.AAVE_SUBGRAPH_README_PATH ||
  '/Users/pabloli/Documents/protocol-subgraphs/README.md';

const CHAIN_RULES = [
  { test: /eth mainnet|ethereum/i, value: { chainId: 1, chainName: 'mainnet' } },
  { test: /polygon/i, value: { chainId: 137, chainName: 'polygon' } },
  { test: /avalanche/i, value: { chainId: 43114, chainName: 'avalanche' } },
  { test: /arbitrum/i, value: { chainId: 42161, chainName: 'arbitrum_one' } },
  { test: /optimism/i, value: { chainId: 10, chainName: 'optimism' } },
  { test: /fantom/i, value: { chainId: 250, chainName: 'fantom' } },
  { test: /harmony/i, value: { chainId: 1666600000, chainName: 'harmony' } },
  { test: /metis/i, value: { chainId: 1088, chainName: 'metis_andromeda' } },
  { test: /gnosis/i, value: { chainId: 100, chainName: 'xdai' } },
  { test: /bnb/i, value: { chainId: 56, chainName: 'bnb' } },
  { test: /base/i, value: { chainId: 8453, chainName: 'base' } },
  { test: /scroll/i, value: { chainId: 534352, chainName: 'scroll' } },
  { test: /zksync/i, value: { chainId: 324, chainName: 'zksync' } },
  { test: /linea/i, value: { chainId: 59144, chainName: 'linea' } },
  { test: /sonic/i, value: { chainId: 146, chainName: 'sonic' } },
  { test: /celo/i, value: { chainId: 42220, chainName: 'celo' } },
  { test: /soneium/i, value: { chainId: 1868, chainName: 'soneium' } },
  { test: /plasma/i, value: { chainId: 9745, chainName: 'plasma' } },
  { test: /ink/i, value: { chainId: 57073, chainName: 'ink' } },
  { test: /mantle/i, value: { chainId: 5000, chainName: 'mantle' } },
  { test: /megaeth/i, value: { chainId: 4326, chainName: 'megaeth' } },
];

function inferChain(title) {
  for (const rule of CHAIN_RULES) {
    if (rule.test.test(title)) return rule.value;
  }
  return { chainId: null, chainName: null };
}

function inferMarket(title) {
  if (/gho/i.test(title)) return 'gho';
  if (/lido/i.test(title)) return 'lido';
  if (/etherfi/i.test(title)) return 'etherfi';
  return 'core';
}

function parseProductionDeployments(markdown) {
  const startMarker = '### Production networks';
  const endMarker = '### Test networks';
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Could not locate Production networks section in README');
  }

  const section = markdown.slice(start, end);
  const lineRegex = /^- \[(.+?)\]\((https?:\/\/[^)]+)\)$/gm;

  const result = [];
  let match;
  while ((match = lineRegex.exec(section)) !== null) {
    const title = match[1].trim();
    const explorerUrl = match[2].trim();
    const idMatch = explorerUrl.match(/\/subgraphs\/([A-Za-z0-9]+)(?:$|\?)/);
    const nameMatch = explorerUrl.match(/\/subgraphs\/name\/([^?\s]+)/);
    const deploymentId = nameMatch ? null : idMatch ? idMatch[1] : null;
    const slug = nameMatch ? nameMatch[1] : null;
    const queryPath = deploymentId ? `id/${deploymentId}` : slug ? `name/${slug}` : null;
    const origin = (() => {
      try {
        return new URL(explorerUrl).origin;
      } catch {
        return null;
      }
    })();
    const queryUrlTemplate = deploymentId
      ? `https://gateway.thegraph.com/api/{apiKey}/subgraphs/id/${deploymentId}`
      : slug && origin
      ? `${origin}/subgraphs/name/${slug}`
      : null;
    const chain = inferChain(title);

    result.push({
      title,
      explorerUrl,
      deploymentId,
      slug,
      queryPath,
      queryUrlTemplate,
      chainId: chain.chainId,
      chainName: chain.chainName,
      market: inferMarket(title),
    });
  }

  return result;
}

async function main() {
  let markdown = '';
  let source = '';

  try {
    const response = await fetch(README_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch README: ${response.status} ${response.statusText}`);
    }
    markdown = await response.text();
    source = README_URL;
  } catch (error) {
    markdown = await readFile(LOCAL_README_PATH, 'utf8');
    source = `local:${LOCAL_README_PATH}`;
    console.warn(
      `⚠️ remote README unavailable, fallback to local file (${LOCAL_README_PATH}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const deployments = parseProductionDeployments(markdown);

  if (deployments.length === 0) {
    throw new Error('No production deployments parsed from README');
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source,
    count: deployments.length,
    deployments,
  };

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outputPath = join(repoRoot, 'docs', 'api', 'aave-subgraph-deployments.snapshot.json');

  await writeFile(outputPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  console.log(`✅ wrote ${snapshot.count} deployment records to ${outputPath}`);
}

main().catch((error) => {
  console.error('❌ sync failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
