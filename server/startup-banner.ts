/**
 * server/startup-banner.ts
 *
 * Startup banner that announces the active bus mode (OMN-4776).
 * Prints a bordered box showing LOCAL BUS or CLOUD BUS + broker address.
 * Emits a MISMATCH warning when OMNIDASH_BUS_MODE disagrees with detected port.
 * Prints NOT CONFIGURED when neither KAFKA_BOOTSTRAP_SERVERS nor KAFKA_BROKERS is set.
 *
 * Wire into server/index.ts before any consumers start:
 *   import { printStartupBanner } from './startup-banner.js';
 *   printStartupBanner();
 */

import { getBrokerString, getBusMode } from './bus-config.js';

/**
 * Print the startup banner to console.log.
 * Never throws — always returns safely.
 */
export function printStartupBanner(): void {
  try {
    const brokerStr = getBrokerString();

    if (brokerStr === 'not configured') {
      console.log('┌─────────────────────────────────────────┐');
      console.log('│  omnidash bus: NOT CONFIGURED           │');
      console.log('│  Set KAFKA_BOOTSTRAP_SERVERS in .env    │');
      console.log('│  or use: npm run dev:local / dev:cloud  │');
      console.log('└─────────────────────────────────────────┘');
      return;
    }

    const detectedMode = getBusMode(brokerStr);
    const declaredMode = (process.env.OMNIDASH_BUS_MODE ?? '').toLowerCase();

    // Check for mismatch between declared mode and detected port
    const hasMismatch =
      declaredMode !== '' &&
      declaredMode !== 'unknown' &&
      detectedMode !== 'unknown' &&
      declaredMode !== detectedMode;

    const modeLabel = detectedMode === 'local' ? 'LOCAL BUS' : detectedMode === 'cloud' ? 'CLOUD BUS' : 'UNKNOWN BUS'; // # cloud-bus-ok OMN-4776

    console.log('┌─────────────────────────────────────────┐');
    console.log(`│  omnidash bus: ${modeLabel.padEnd(25)}│`);
    console.log(`│  brokers: ${brokerStr.padEnd(31)}│`);

    if (hasMismatch) {
      console.log(`│  ⚠ MISMATCH: mode=${declaredMode} port=${detectedMode.toUpperCase().padEnd(10)}│`);
    }

    console.log('└─────────────────────────────────────────┘');

    if (hasMismatch) {
      console.warn(
        `[startup-banner] MISMATCH: OMNIDASH_BUS_MODE="${declaredMode}" but broker port suggests "${detectedMode}". ` +
          `Use npm run dev:${detectedMode} to align mode and broker.`
      );
    }
  } catch {
    // Never throw from startup banner — non-fatal
    console.log('[startup-banner] could not determine bus mode (broker env not set)');
  }
}
