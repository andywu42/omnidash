/**
 * FeatureNotEnabledBanner (OMN-2849)
 *
 * Shown when a dashboard's data source returns successfully but all metrics
 * are zero, indicating the upstream feature flag is not enabled and no events
 * are being produced.
 *
 * Usage:
 *   import { FeatureNotEnabledBanner } from '@/components/FeatureNotEnabledBanner';
 *   <FeatureNotEnabledBanner
 *     featureName="Pattern Enforcement"
 *     eventTopic="onex.evt.omniclaude.pattern-enforcement.v1"
 *     flagHint="ENABLE_PATTERN_ENFORCEMENT"
 *   />
 */

import { Info } from 'lucide-react';
import { Link } from 'wouter';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface FeatureNotEnabledBannerProps {
  /** Human-readable feature name (e.g., "Pattern Enforcement"). */
  featureName: string;
  /** The Kafka topic that produces events for this feature. */
  eventTopic: string;
  /** Optional: the environment variable / flag name that enables this feature. */
  flagHint?: string;
}

export function FeatureNotEnabledBanner({
  featureName,
  eventTopic,
  flagHint,
}: FeatureNotEnabledBannerProps) {
  return (
    <Alert variant="default" className="border-blue-500/50 bg-blue-500/10">
      <Info className="h-4 w-4 text-blue-500" />
      <AlertTitle className="text-blue-400">Feature Not Enabled</AlertTitle>
      <AlertDescription className="text-muted-foreground">
        The <strong>{featureName}</strong> dashboard requires events from{' '}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">{eventTopic}</code>.
        No events have been received yet &mdash; the upstream producer may not have this feature
        enabled.
        {flagHint && (
          <>
            {' '}
            Check that <code className="text-xs bg-muted px-1 py-0.5 rounded">{flagHint}</code> is
            set to <code className="text-xs bg-muted px-1 py-0.5 rounded">true</code> in the
            producer&apos;s environment.
          </>
        )}{' '}
        <Link href="/feature-flags" className="underline">
          Manage feature flags
        </Link>
      </AlertDescription>
    </Alert>
  );
}
