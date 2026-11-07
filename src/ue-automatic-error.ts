export type AutomaticSyncReason = 'index-incomplete' | 'project-busy' | 'index-replaced' | 'rebuild-required' | 'index-data-inconsistent' | 'index-lock-error';

export class AutomaticSyncError extends Error {
  constructor(readonly reason: AutomaticSyncReason, message: string) {
    super(message);
  }
}

export function automaticSyncReason(error: unknown): string {
  if (error instanceof AutomaticSyncError) return error.reason;
  if (error instanceof Error && error.name === 'LockUnavailableError') return 'project-busy';
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  return 'sync-failed';
}
