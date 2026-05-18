export interface GscFetchState {
  lastSuccessAt: string | null;
  lastTargetDate: string | null;
  lastRowsUpserted: number;
  lastError: string | null;
}

let state: GscFetchState = {
  lastSuccessAt: null,
  lastTargetDate: null,
  lastRowsUpserted: 0,
  lastError: null,
};

export function getGscFetchState(): Readonly<GscFetchState> {
  return state;
}

export function setGscFetchSuccess(result: { targetDate: string; rowsUpserted: number }): void {
  state = {
    lastSuccessAt: new Date().toISOString(),
    lastTargetDate: result.targetDate,
    lastRowsUpserted: result.rowsUpserted,
    lastError: null,
  };
}

export function setGscFetchFailure(errorMsg: string): void {
  state = { ...state, lastError: errorMsg };
}
