/**
 * Race a promise against a timeout.
 * Rejects with an Error if the promise does not settle within `ms` milliseconds.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
