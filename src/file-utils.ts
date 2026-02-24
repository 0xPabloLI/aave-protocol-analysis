import { rename, writeFile } from 'fs/promises';

type JsonReplacer =
  | ((this: any, key: string, value: any) => any)
  | Array<number | string>
  | null;

interface WriteJsonAtomicOptions {
  replacer?: JsonReplacer;
  space?: number;
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: WriteJsonAtomicOptions = {}
): Promise<void> {
  const { replacer = null, space = 2 } = options;
  const payload = JSON.stringify(value, replacer as any, space);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, payload, 'utf-8');
  await rename(tempPath, filePath);
}
