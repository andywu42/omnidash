/**
 * Alert History API Routes
 *
 * Provides historical alert data by combining:
 * 1. Skill invocations for alert-related skills (hook_health_alert, slack_gate)
 * 2. Snapshot of current active alerts from the existing alert engine
 *
 * Data source: skill_invocations table + active alert computation
 */

import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getIntelligenceDb } from './storage';
import { getAllAlertMetrics } from './alert-helpers';
import { safeInterval } from './sql-safety';

export const alertHistoryRoutes = Router();

/** Alert severity levels matching the Slack alerter contract */
type AlertSeverity = 'critical' | 'error' | 'warning' | 'info';

interface AlertHistoryEntry {
  id: string;
  timestamp: string;
  severity: AlertSeverity;
  source: string;
  message: string;
  success: boolean;
  durationMs: number;
}

interface AlertHistoryStats {
  total24h: number;
  bySeverity: Record<AlertSeverity, number>;
  bySource: Record<string, number>;
  successRate: number | null;
}

interface AlertHistoryResponse {
  alerts: AlertHistoryEntry[];
  stats: AlertHistoryStats;
  activeAlerts: Array<{
    level: 'critical' | 'warning';
    message: string;
  }>;
  _demo?: boolean;
}

const ALERT_SKILL_NAMES = ['hook_health_alert', 'slack_gate', 'hook_health_check'];

const SUPPORTED_WINDOWS: Record<string, string> = {
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '24 hours',
  '7d': '7 days',
};

/**
 * Classify severity from skill invocation error/metadata.
 * Skills that failed are 'error'; successful hook_health_alert invocations
 * are 'warning' by default (the alert fired); slack_gate is 'info'.
 */
function classifySeverity(
  skillName: string,
  success: boolean,
  _error: string | null
): AlertSeverity {
  if (!success) return 'error';
  if (skillName === 'hook_health_alert' || skillName === 'hook_health_check') return 'warning';
  if (skillName === 'slack_gate') return 'info';
  return 'info';
}

/**
 * GET /api/alert-history
 *
 * Returns alert history entries and summary stats.
 * Query params: ?window=1h|6h|24h|7d (default: 24h)
 */
alertHistoryRoutes.get('/', async (req, res) => {
  try {
    const windowParam = typeof req.query.window === 'string' ? req.query.window : '24h';
    const intervalStr = SUPPORTED_WINDOWS[windowParam];
    if (!intervalStr) {
      return res.status(400).json({
        error: `Invalid window. Use one of: ${Object.keys(SUPPORTED_WINDOWS).join(', ')}`,
      });
    }

    const db = getIntelligenceDb();

    // Build skill name filter using parameterized sql.join (no sql.raw)
    const skillParams = ALERT_SKILL_NAMES.map((s) => sql`${s}`);

    // Query alert-related skill invocations
    const alertRows = await db.execute<{
      id: string;
      skill_name: string;
      session_id: string | null;
      duration_ms: number;
      success: boolean;
      error: string | null;
      created_at: string;
    }>(sql`
      SELECT id, skill_name, session_id, duration_ms, success, error, created_at
      FROM skill_invocations
      WHERE skill_name IN (${sql.join(skillParams, sql`, `)})
        AND created_at > NOW() - INTERVAL ${safeInterval(intervalStr)}
      ORDER BY created_at DESC
      LIMIT 200
    `);

    const alerts: AlertHistoryEntry[] = alertRows.rows.map((row) => ({
      id: String(row.id),
      timestamp: row.created_at,
      severity: classifySeverity(row.skill_name, row.success, row.error),
      source: row.skill_name,
      message: row.error || `${row.skill_name} invoked successfully`,
      success: row.success,
      durationMs: row.duration_ms,
    }));

    // Compute stats
    const severityCounts: Record<AlertSeverity, number> = {
      critical: 0,
      error: 0,
      warning: 0,
      info: 0,
    };
    const sourceCounts: Record<string, number> = {};
    let successCount = 0;

    for (const alert of alerts) {
      severityCounts[alert.severity]++;
      sourceCounts[alert.source] = (sourceCounts[alert.source] || 0) + 1;
      if (alert.success) successCount++;
    }

    const stats: AlertHistoryStats = {
      total24h: alerts.length,
      bySeverity: severityCounts,
      bySource: sourceCounts,
      successRate: alerts.length > 0 ? successCount / alerts.length : null,
    };

    // Also fetch current active alerts
    const metrics = await getAllAlertMetrics();
    const activeAlerts: Array<{ level: 'critical' | 'warning'; message: string }> = [];

    if (metrics.errorRate > 0.1) {
      activeAlerts.push({
        level: 'critical',
        message: `Error rate at ${(metrics.errorRate * 100).toFixed(1)}%`,
      });
    } else if (metrics.errorRate > 0.05) {
      activeAlerts.push({
        level: 'warning',
        message: `Error rate at ${(metrics.errorRate * 100).toFixed(1)}%`,
      });
    }
    if (metrics.injectionSuccessRate < 0.9) {
      activeAlerts.push({
        level: 'critical',
        message: `Injection success rate at ${(metrics.injectionSuccessRate * 100).toFixed(1)}%`,
      });
    } else if (metrics.injectionSuccessRate < 0.95) {
      activeAlerts.push({
        level: 'warning',
        message: `Injection success rate at ${(metrics.injectionSuccessRate * 100).toFixed(1)}%`,
      });
    }
    if (metrics.avgResponseTime > 2000) {
      activeAlerts.push({
        level: 'warning',
        message: `High response time: ${metrics.avgResponseTime}ms`,
      });
    }
    if (metrics.successRate < 0.85) {
      activeAlerts.push({
        level: 'warning',
        message: `Low success rate: ${(metrics.successRate * 100).toFixed(1)}%`,
      });
    }

    return res.json({ alerts, stats, activeAlerts } as AlertHistoryResponse);
  } catch (err) {
    console.error('[alert-history] query failed:', err);

    return res.status(500).json({
      error: 'Failed to fetch alert history',
      alerts: [],
      stats: {
        total24h: 0,
        bySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        bySource: {},
        successRate: null,
      },
      activeAlerts: [],
    });
  }
});
