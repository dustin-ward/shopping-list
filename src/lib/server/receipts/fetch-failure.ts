/**
 * One sentence for a failed engine `fetch`, shared by the OCR and fallback
 * helper clients. `AbortSignal.timeout` reports a `TimeoutError`; a connection
 * refusal arrives with the useful reason nested in `cause`.
 */
export function describeFetchFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'the request timed out';
  }
  if (error instanceof Error && error.cause instanceof Error) {
    return error.cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}
