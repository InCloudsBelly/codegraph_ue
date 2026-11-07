import type { IndexOptions, SyncResult } from '../index';
import { assertNoPendingIndexPublication, isInitialized } from '../directory';
import { getIndexingConfigStatus } from '../indexing-config';
import { detectWorktreeIndexMismatch } from '../sync/worktree';
import { automaticSyncReason } from '../ue-automatic-error';
import type { UeReadOutcome } from '../mcp/tools';

type Result =
  | { protocol: 1; status: 'not-applicable' }
  | { protocol: 1; status: 'unverified'; reason: string }
  | { protocol: 1; status: 'fresh'; revision: string; changes: Pick<SyncResult, 'filesAdded' | 'filesModified' | 'filesRemoved' | 'filesChecked'>; text?: string };

export async function reconcileUe(projectRoot: string, options: {
  query?: string; paths?: string[]; onProgress?: IndexOptions['onProgress']; signal?: AbortSignal;
}): Promise<Result> {
  const refused = (reason: string): Result => ({ protocol: 1, status: 'unverified', reason });
  try { assertNoPendingIndexPublication(projectRoot); }
  catch { return refused('publication-recovery-required'); }
  if (getIndexingConfigStatus(projectRoot).error) return refused('indexing-config-invalid');
  if (!isInitialized(projectRoot)) return refused('explicit-initialization-required');
  if (detectWorktreeIndexMismatch(projectRoot, projectRoot)) return refused('worktree-mismatch');
  const { default: CodeGraph } = await import('../index');
  const graph = await CodeGraph.open(projectRoot, { automaticOpen: 'ue' }).catch(() => null);
  if (!graph) return refused('index-open-failed');
  try {
    const profile = graph.getExistingIndexProfile();
    if (profile === 'generic') return { protocol: 1, status: 'not-applicable' };
    if (profile === 'unverified') return refused('index-profile-unverified');
    const fresh = (revision: string, sync: SyncResult, text?: string): Result => ({
      protocol: 1, status: 'fresh', revision,
      changes: { filesAdded: sync.filesAdded, filesModified: sync.filesModified, filesRemoved: sync.filesRemoved, filesChecked: sync.filesChecked },
      ...(text !== undefined ? { text } : {}),
    });
    if (options.query !== undefined) {
      const { ToolHandler } = await import('../mcp/tools');
      const handler = new ToolHandler(graph);
      try {
        const outcome: UeReadOutcome = { onProgress: options.onProgress, signal: options.signal };
        const reply = await handler.execute('codegraph_explore', { query: options.query }, undefined, outcome);
        options.signal?.throwIfAborted();
        if (reply.isError || !outcome.revision || !outcome.sync) return refused(outcome.reason ?? 'query-unverified');
        return fresh(outcome.revision, outcome.sync, reply.content[0]?.text ?? '');
      } finally { await handler.closeAll(); }
    }
    const sync = await graph.syncAutomatically(options);
    const revision = graph.getUeReadRevision();
    const scope = await graph.getUeScopeStatus({ includeCoverage: false });
    options.signal?.throwIfAborted();
    if (!revision || scope?.state !== 'fresh' || graph.getUeReadRevision() !== revision) {
      return refused(scope?.reason ?? 'scope-state-changed-during-check');
    }
    return fresh(revision, sync);
  } catch (error) {
    return refused(automaticSyncReason(error));
  } finally { graph.destroy(); }
}
