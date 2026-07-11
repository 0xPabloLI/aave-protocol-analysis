import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = join(repoRoot, 'docs', 'api', 'aave-subgraph-deployments.snapshot.json');
const originalSnapshotPath = '/tmp/original-snapshot.json';

/**
 * Compare two snapshot objects, ignoring the generatedAt timestamp field.
 * Returns true if there are actual changes (excluding timestamp).
 */
function hasActualChanges(oldSnapshot, newSnapshot) {
  // Remove generatedAt from both objects for comparison
  const oldWithoutTimestamp = { ...oldSnapshot };
  const newWithoutTimestamp = { ...newSnapshot };
  delete oldWithoutTimestamp.generatedAt;
  delete newWithoutTimestamp.generatedAt;

  // Deep comparison by stringifying (order matters for JSON.stringify, but deployments should be stable)
  const oldStr = JSON.stringify(oldWithoutTimestamp, null, 2);
  const newStr = JSON.stringify(newWithoutTimestamp, null, 2);

  return oldStr !== newStr;
}

async function main() {
  try {
    // Read the current snapshot file (after sync)
    const newSnapshotContent = await readFile(snapshotPath, 'utf8');
    const newSnapshot = JSON.parse(newSnapshotContent);

    // Read the original snapshot file (saved before sync)
    let oldSnapshot = null;
    try {
      const oldSnapshotContent = await readFile(originalSnapshotPath, 'utf8');
      oldSnapshot = JSON.parse(oldSnapshotContent);
    } catch (error) {
      // File doesn't exist - assume there are changes
      console.log('⚠️  Could not read original file, assuming changes exist');
      process.exit(0); // Exit with 0 to indicate changes exist
    }

    // Compare snapshots (excluding timestamp)
    const hasChanges = hasActualChanges(oldSnapshot, newSnapshot);

    if (hasChanges) {
      console.log('✅ Actual changes detected (excluding timestamp)');
      process.exit(0); // Exit with 0 to indicate changes exist
    } else {
      console.log('ℹ️  No actual changes detected (only timestamp updated)');
      process.exit(1); // Exit with 1 to indicate no changes
    }
  } catch (error) {
    console.error('❌ Check failed:', error instanceof Error ? error.message : String(error));
    // On error, assume changes exist to be safe
    process.exit(0);
  }
}

main();
