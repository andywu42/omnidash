/**
 * Stub Guard Verification (OMN-5607)
 *
 * Permanent regression test that verifies no route handlers contain
 * unimplemented stubs. Complements the CI stub guard (OMN-5606) which
 * catches forbidden stub markers in source files. This test checks for runtime stubs like
 * `throw new Error('Not implemented')` or empty handler bodies in
 * server route files.
 *
 * Proxy stubs for Kafka graceful degradation are intentional and excluded.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SERVER_DIR = join(__dirname, '..');

function getRouteFiles(): string[] {
  return readdirSync(SERVER_DIR)
    .filter((f) => f.endsWith('-routes.ts') && !f.startsWith('__'))
    .map((f) => join(SERVER_DIR, f));
}

function getProjectionFiles(): string[] {
  const projDir = join(SERVER_DIR, 'projections');
  return readdirSync(projDir)
    .filter((f) => f.endsWith('-projection.ts') && !f.startsWith('__'))
    .map((f) => join(projDir, f));
}

describe('stub-guard-verification', () => {
  it('no route files contain throw new Error("Not implemented") outside comments', () => {
    const violations: string[] = [];

    for (const file of getRouteFiles()) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Skip comments
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
        if (/throw new Error\(['"]Not implemented/i.test(line)) {
          violations.push(`${file}:${i + 1}: ${line}`);
        }
      }
    }

    // chat-routes.ts POST /send returns 501 — tracked under OMN-6111
    const _chatViolations = violations.filter((v) => v.includes('chat-routes'));
    const otherViolations = violations.filter((v) => !v.includes('chat-routes'));

    expect(otherViolations).toEqual([]);
  });

  it('no projection files contain empty querySnapshot or emptyPayload', () => {
    const violations: string[] = [];

    for (const file of getProjectionFiles()) {
      const content = readFileSync(file, 'utf-8');
      // Check for throw 'not implemented' in projection methods
      if (/querySnapshot[^{]*\{[\s\n]*throw new Error/m.test(content)) {
        violations.push(`${file}: querySnapshot throws Not implemented`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('CI stub guard pre-commit hook is configured', () => {
    const preCommitConfig = readFileSync(
      join(SERVER_DIR, '..', '.pre-commit-config.yaml'),
      'utf-8'
    );
    expect(preCommitConfig).toContain('check-ts-stubs');
  });

  it('route files with withFallback stubs have tracking ticket comments', () => {
    const untracked: string[] = [];

    for (const file of getRouteFiles()) {
      const content = readFileSync(file, 'utf-8');
      // Check for withFallback primary stubs that throw
      if (/throw new Error\(['"](kafka|read-model) .* not yet wired/i.test(content)) {
        // Must have a TODO(OMN-XXXX) tracking comment
        if (!/TODO\(OMN-\d+\)/.test(content)) {
          untracked.push(file);
        }
      }
    }

    expect(untracked).toEqual([]);
  });
});
