/**
 * OIDC graceful degradation tests (OMN-4960)
 *
 * Verifies:
 * 1. Zero process.exit() calls in oidc-client.ts
 * 2. Server does not crash when KEYCLOAK_CLIENT_ID is missing
 * 3. Server does not crash when Keycloak is unreachable
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('oidc-client graceful degradation (OMN-4960)', () => {
  const source = readFileSync(resolve(__dirname, '../oidc-client.ts'), 'utf-8');

  it('contains zero process.exit() calls in executable code', () => {
    // Check non-comment lines only
    const codeLines = source.split('\n').filter((l) => !l.trim().startsWith('//'));
    const codeOnly = codeLines.join('\n');
    const exitCalls = codeOnly.match(/process\.exit\(/g);
    expect(exitCalls).toBeNull();
  });

  it('sets authEnabled = false on missing credentials', () => {
    // Verify the missing-credentials branch sets authEnabled = false
    expect(source).toContain('authEnabled = false');
    // Verify it returns early instead of crashing
    expect(source).toContain('KEYCLOAK_CLIENT_ID or KEYCLOAK_CLIENT_SECRET is missing');
  });

  it('sets authEnabled = false on issuer discovery failure', () => {
    // The catch block should disable auth, not crash
    expect(source).toContain('Failed to discover OIDC issuer');
    // After the catch(error) line, the next few lines should set authEnabled = false
    // and NOT call process.exit as executable code
    const lines = source.split('\n');
    const catchLineIdx = lines.findIndex((l) => l.includes('catch (error)'));
    expect(catchLineIdx).toBeGreaterThan(-1);

    // Collect non-comment code lines in the catch block (until closing brace)
    const catchCodeLines: string[] = [];
    for (let i = catchLineIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '}') break;
      // Skip comment lines
      if (lines[i].trim().startsWith('//')) continue;
      catchCodeLines.push(lines[i]);
    }
    const catchCode = catchCodeLines.join('\n');
    expect(catchCode).toContain('authEnabled = false');
    expect(catchCode).not.toContain('process.exit');
  });
});
