/**
 * Skill Dashboard API Routes (OMN-5278)
 *
 * REST endpoints for the skill invocation dashboard:
 *   GET /api/skills  — top skills by invocation count + recent invocations
 *
 * Data is served via SkillProjection (DB-backed, TTL-cached).
 * Per OMN-2325: no direct DB imports in route files.
 */

import { Router } from 'express';
import { skillProjection } from './projection-bootstrap';

export function createSkillRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const payload = await skillProjection.ensureFresh();
      return res.json({ skills: payload.skills, recent: payload.recent, totals: payload.totals });
    } catch (err) {
      console.error('[skill-routes] GET /api/skills error:', err);
      return res.json({
        skills: [],
        recent: [],
        totals: { totalInvocations: 0, uniqueSkills: 0, overallSuccessRate: 0 },
      });
    }
  });

  return router;
}
