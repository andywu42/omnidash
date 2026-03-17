/**
 * LlmHealthProjection — DB-backed projection for LLM endpoint health data (OMN-5279)
 *
 * Projects from: llm_health_snapshots table (created by migration 0024_llm_health_snapshots)
 *
 * Snapshot payload shape:
 *   { models: LlmHealthSnapshotRow[]; history: LlmHealthSnapshotRow[]; generatedAt: string }
 *
 * Routes access this via llmHealthProjection.ensureFresh() — no direct DB imports
 * allowed in route files (OMN-2325).
 */

import { desc, eq } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import { llmHealthSnapshots } from '@shared/intelligence-schema';
import type { LlmHealthSnapshotRow } from '@shared/intelligence-schema';

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

export interface LlmHealthPayload {
  models: LlmHealthSnapshotRow[];
  history: LlmHealthSnapshotRow[];
  generatedAt: string;
}

export class LlmHealthProjection extends DbBackedProjectionView<LlmHealthPayload> {
  readonly viewId = 'llm-health';

  protected emptyPayload(): LlmHealthPayload {
    return { models: [], history: [], generatedAt: new Date().toISOString() };
  }

  protected async querySnapshot(db: Db): Promise<LlmHealthPayload> {
    try {
      const latestPerModel = await db
        .select()
        .from(llmHealthSnapshots)
        .orderBy(desc(llmHealthSnapshots.createdAt))
        .limit(500);

      // Deduplicate: keep only the most recent row per model_id
      const seenModels = new Map<string, LlmHealthSnapshotRow>();
      for (const row of latestPerModel) {
        if (!seenModels.has(row.modelId)) {
          seenModels.set(row.modelId, row);
        }
      }

      return {
        models: [...seenModels.values()],
        history: latestPerModel.slice(0, 200),
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      // Graceful degrade: table may not exist yet (migration 0024 pending)
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '42P01') {
        // PostgreSQL "undefined_table" — migration not yet applied
        return this.emptyPayload();
      }
      throw err;
    }
  }
}
