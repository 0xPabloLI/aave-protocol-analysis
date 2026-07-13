/**
 * V4-specific error types.
 *
 * Kept in a separate file with zero dependencies so that tests can import
 * these classes without triggering the full @aave/client-v4 import chain.
 */

export class V4ChainsFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V4ChainsFetchError';
  }
}