/**
 * Tests for GitHub webhook HMAC-SHA256 signature verification middleware.
 * TDD: Written before implementation [OMN-6721].
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import { verifyGitHubWebhookSignature } from '../lib/github-webhook-signature';

function signPayload(payload: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(payload, 'utf8');
  return 'sha256=' + hmac.digest('hex');
}

function createTestApp(secret?: string) {
  const app = express();

  // Mimic the rawBody capture from omnidash's server/index.ts
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    })
  );

  // Set env var for the middleware
  if (secret !== undefined) {
    process.env.GITHUB_WEBHOOK_SECRET = secret;
  }

  app.post('/webhook', verifyGitHubWebhookSignature, (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  return app;
}

describe('verifyGitHubWebhookSignature', () => {
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const testSecret = 'test-webhook-secret-123';
  const testPayload = JSON.stringify({ action: 'opened', number: 1 });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    } else {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    }
  });

  it('should pass with valid signature', async () => {
    const app = createTestApp(testSecret);
    const signature = signPayload(testPayload, testSecret);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(testPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('should return 401 for invalid signature', async () => {
    const app = createTestApp(testSecret);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=invalid')
      .send(testPayload);

    expect(res.status).toBe(401);
  });

  it('should return 401 for missing signature header', async () => {
    const app = createTestApp(testSecret);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(testPayload);

    expect(res.status).toBe(401);
  });

  it('should return 500 when GITHUB_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const app = createTestApp(undefined);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=anything')
      .send(testPayload);

    expect(res.status).toBe(500);
  });

  it('should reject signature with wrong prefix', async () => {
    const app = createTestApp(testSecret);
    const hmac = createHmac('sha256', testSecret);
    hmac.update(testPayload, 'utf8');
    const wrongPrefix = 'sha1=' + hmac.digest('hex');

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', wrongPrefix)
      .send(testPayload);

    expect(res.status).toBe(401);
  });
});
