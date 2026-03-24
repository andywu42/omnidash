/**
 * ReviewCalibrationProjection — DB-backed projection for review calibration data (OMN-6176)
 *
 * Projects from: review_calibration_runs_rm table
 *
 * Snapshot payload holds:
 * - history: recent calibration runs (optionally filtered by model)
 * - scores: per-model accuracy aggregates
 * - fewshot: few-shot prompt metadata derived from calibration run count
 *
 * Routes access this via reviewCalibrationProjection.ensureFresh() — no direct
 * DB imports allowed in route files (OMN-2325).
 */

import { sql, desc } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import { reviewCalibrationRuns } from '@shared/intelligence-schema';

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

export interface CalibrationRun {
  run_id: string;
  ground_truth_model: string;
  challenger_model: string;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  noise_ratio: number | null;
  created_at: string | null;
}

export interface CalibrationModelScore {
  model_id: string;
  score_correctness: number;
  run_count: number;
  calibration_run_count: number;
}

export interface CalibrationFewshot {
  prompt_version: string | null;
  example_count: number;
  last_updated: string | null;
}

export interface ReviewCalibrationPayload {
  runs: CalibrationRun[];
  models: CalibrationModelScore[];
  fewshot: CalibrationFewshot;
}

export class ReviewCalibrationProjection extends DbBackedProjectionView<ReviewCalibrationPayload> {
  readonly viewId = 'review-calibration';

  protected emptyPayload(): ReviewCalibrationPayload {
    return {
      runs: [],
      models: [],
      fewshot: { prompt_version: null, example_count: 0, last_updated: null },
    };
  }

  protected async querySnapshot(db: Db): Promise<ReviewCalibrationPayload> {
    try {
      const [runRows, scoreRows, fewshotRows] = await Promise.all([
        // History: last 50 runs
        db
          .select({
            runId: reviewCalibrationRuns.runId,
            groundTruthModel: reviewCalibrationRuns.groundTruthModel,
            challengerModel: reviewCalibrationRuns.challengerModel,
            precision: reviewCalibrationRuns.precision,
            recall: reviewCalibrationRuns.recall,
            f1: reviewCalibrationRuns.f1,
            noiseRatio: reviewCalibrationRuns.noiseRatio,
            createdAt: reviewCalibrationRuns.createdAt,
          })
          .from(reviewCalibrationRuns)
          .orderBy(desc(reviewCalibrationRuns.createdAt))
          .limit(50),

        // Scores: per-model aggregates
        db
          .select({
            modelId: reviewCalibrationRuns.challengerModel,
            scoreCorrectness: sql<number>`ROUND(AVG(${reviewCalibrationRuns.f1})::numeric, 4)`,
            runCount: sql<number>`COUNT(*)::int`,
            calibrationRunCount: sql<number>`COUNT(DISTINCT ${reviewCalibrationRuns.runId})::int`,
          })
          .from(reviewCalibrationRuns)
          .groupBy(reviewCalibrationRuns.challengerModel)
          .orderBy(sql`AVG(${reviewCalibrationRuns.f1}) DESC`),

        // Fewshot: count + last updated
        db
          .select({
            exampleCount: sql<number>`COUNT(*)::int`,
            lastUpdated: sql<string>`MAX(${reviewCalibrationRuns.createdAt})::text`,
          })
          .from(reviewCalibrationRuns),
      ]);

      const runs: CalibrationRun[] = runRows.map((r) => ({
        run_id: r.runId,
        ground_truth_model: r.groundTruthModel,
        challenger_model: r.challengerModel,
        precision: r.precision,
        recall: r.recall,
        f1: r.f1,
        noise_ratio: r.noiseRatio,
        created_at: r.createdAt?.toISOString() ?? null,
      }));

      const models: CalibrationModelScore[] = scoreRows.map((r) => ({
        model_id: r.modelId,
        score_correctness: parseFloat(r.scoreCorrectness?.toString() ?? '0'),
        run_count: r.runCount,
        calibration_run_count: r.calibrationRunCount,
      }));

      const fewshotRow = fewshotRows[0];
      const fewshot: CalibrationFewshot = {
        prompt_version: fewshotRow && fewshotRow.exampleCount > 0 ? 'v1' : null,
        example_count: fewshotRow?.exampleCount ?? 0,
        last_updated: fewshotRow?.lastUpdated ?? null,
      };

      return { runs, models, fewshot };
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '42P01') {
        // PostgreSQL "undefined_table" — migration not yet applied
        return this.emptyPayload();
      }
      throw err;
    }
  }

  /**
   * Query history with optional model filter and limit.
   * Used by the /history endpoint which supports query params.
   */
  async queryHistory(model?: string, limit = 50): Promise<CalibrationRun[]> {
    const db = tryGetIntelligenceDb();
    if (!db) return [];

    try {
      const conditions = model
        ? sql`${reviewCalibrationRuns.challengerModel} = ${model}`
        : undefined;

      const rows = await db
        .select({
          runId: reviewCalibrationRuns.runId,
          groundTruthModel: reviewCalibrationRuns.groundTruthModel,
          challengerModel: reviewCalibrationRuns.challengerModel,
          precision: reviewCalibrationRuns.precision,
          recall: reviewCalibrationRuns.recall,
          f1: reviewCalibrationRuns.f1,
          noiseRatio: reviewCalibrationRuns.noiseRatio,
          createdAt: reviewCalibrationRuns.createdAt,
        })
        .from(reviewCalibrationRuns)
        .where(conditions)
        .orderBy(desc(reviewCalibrationRuns.createdAt))
        .limit(limit);

      return rows.map((r) => ({
        run_id: r.runId,
        ground_truth_model: r.groundTruthModel,
        challenger_model: r.challengerModel,
        precision: r.precision,
        recall: r.recall,
        f1: r.f1,
        noise_ratio: r.noiseRatio,
        created_at: r.createdAt?.toISOString() ?? null,
      }));
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '42P01') return [];
      throw err;
    }
  }
}
