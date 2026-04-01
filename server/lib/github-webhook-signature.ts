/**
 * GitHub webhook HMAC-SHA256 signature verification middleware.
 *
 * Verifies the `X-Hub-Signature-256` header against `req.rawBody`
 * using `crypto.timingSafeEqual()` to prevent timing attacks.
 *
 * Apply this middleware only to webhook routes, not globally.
 *
 * OMN-6721
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Express middleware that verifies GitHub webhook signatures.
 *
 * Expects `req.rawBody` to be a Buffer (captured by the JSON body parser's
 * `verify` callback in server/index.ts).
 *
 * Returns:
 * - 500 if `GITHUB_WEBHOOK_SECRET` is not configured
 * - 401 if the signature header is missing or invalid
 * - Calls `next()` on valid signature
 */
export function verifyGitHubWebhookSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'GITHUB_WEBHOOK_SECRET is not configured' });
    return;
  }

  const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
  if (!signatureHeader) {
    res.status(401).json({ error: 'Missing X-Hub-Signature-256 header' });
    return;
  }

  if (!signatureHeader.startsWith('sha256=')) {
    res.status(401).json({ error: 'Invalid signature format' });
    return;
  }

  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!rawBody) {
    res.status(401).json({ error: 'Missing raw body for signature verification' });
    return;
  }

  const expectedSignature = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

  // Use timingSafeEqual to prevent timing attacks.
  // Both buffers must be the same length for timingSafeEqual.
  const sigBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  next();
}
