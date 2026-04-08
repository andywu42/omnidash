/**
 * Chart Theme Constants
 *
 * Shared Recharts styling constants for dark-mode-compatible tooltips and cursors.
 * Use these instead of inline contentStyle objects to ensure consistent theming.
 */

import type { CSSProperties } from 'react';

/**
 * Standard Recharts Tooltip contentStyle for dark-mode compatibility.
 * Apply to all `<Tooltip contentStyle={TOOLTIP_STYLE} />` instances.
 */
export const TOOLTIP_STYLE: CSSProperties = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '6px',
  fontSize: '12px',
};

/**
 * Compact variant for small sparkline tooltips (11px font).
 */
export const TOOLTIP_STYLE_SM: CSSProperties = {
  ...TOOLTIP_STYLE,
  fontSize: '11px',
};
