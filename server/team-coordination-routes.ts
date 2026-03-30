/**
 * Agent Coordination API Routes (OMN-7036)
 *
 * REST endpoint for the agent coordination dashboard page.
 * Reads team events from the team_events table via TeamEventsProjection.
 *
 * GET /api/team-coordination — Recent team events + summary
 *
 * Per OMN-2325: route files must not use DB accessors directly.
 * All DB access is delegated to the projection.
 */

import { Router } from 'express';
import { TeamEventsProjection } from './projections/team-events-projection';

const router = Router();
const projection = new TeamEventsProjection();

/**
 * GET /api/team-coordination
 *
 * Returns recent team events and summary statistics.
 * Supports optional ?surface= filter for dispatch_surface.
 */
router.get('/', async (req, res) => {
  try {
    const snapshot = await projection.ensureFresh();

    // Optional client-side filter by dispatch_surface
    const surfaceFilter = req.query.surface as string | undefined;
    if (surfaceFilter) {
      const filtered = snapshot.recent.filter((e) => e.dispatch_surface === surfaceFilter);
      return res.json({ ...snapshot, recent: filtered });
    }

    return res.json(snapshot);
  } catch (err) {
    console.error('[team-coordination] Error fetching events:', err);
    return res.status(500).json({
      error: 'Failed to fetch team coordination events',
      recent: [],
      summary: { total_events: 0, surface_counts: {}, event_type_counts: {} },
    });
  }
});

export default router;
