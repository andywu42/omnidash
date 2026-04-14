import express, { type Express } from 'express';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer, createLogger } from 'vite';
import { type Server } from 'http';
import viteConfig from '../vite.config';
import { nanoid } from 'nanoid';

const viteLogger = createLogger();

export function log(message: string, source = 'express') {
  const formattedTime = new Date().toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: 'custom',
  });

  app.use((req, res, next) => {
    // Skip Vite middlewares for API routes — they must be handled by Express
    if (req.url.startsWith('/api/') || req.url.startsWith('/api?')) {
      return next();
    }
    vite.middlewares.handle(req, res, next);
  });
  // lgtm[js/missing-rate-limiting] -- dev-only SPA HTML handler; rate limiting is not applicable here
  app.use('*', async (req, res, next) => {
    const url = req.originalUrl;

    // Never serve HTML for API routes
    if (url.startsWith('/api/') || url.startsWith('/api?')) {
      return next();
    }

    try {
      const clientTemplate = path.resolve(import.meta.dirname, '..', 'client', 'index.html');

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, 'utf-8');
      template = template.replace(`src="/src/main.tsx"`, `src="/src/main.tsx?v=${nanoid()}"`);
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, 'public');

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath));

  // Read index.html once at startup to avoid per-request filesystem access
  const indexHtml = fs.readFileSync(path.resolve(distPath, 'index.html'), 'utf-8');

  // fall through to index.html if the file doesn't exist (skip API routes)
  app.use('*', (req, res, next) => {
    if (req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/api?')) {
      return next();
    }
    res.status(200).set({ 'Content-Type': 'text/html' }).end(indexHtml);
  });
}
