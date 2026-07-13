import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { keysRouter } from './routes/keys.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter } from './routes/proxy.js';
import { fallbackRouter } from './routes/fallback.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { agentRouter } from './routes/agent.js';
import { capabilitiesRouter } from './routes/capabilities.js';
import { canonRouter } from './routes/canon.js';
import { modelPerfRouter } from './routes/modelPerf.js';
import { mcpRouter } from './routes/mcp.js';
import { errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  // CSP intentionally disabled — the SPA bundles inline styles and the OG
  // image is loaded from the same origin; enabling helmet's default CSP
  // breaks the React build's hashed-asset loader. HSTS off because this is
  // a single-user local proxy, served over HTTP on localhost. Both should
  // stay disabled unless someone serves the proxy over HTTPS publicly
  // (which is also not a supported deployment — see README).
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(cors());
  // 25mb: vision requests carry base64-encoded images inline (a data: URI in an
  // image_url part). A single ~18mb image is ~24mb base64; 1mb rejected real
  // images with 413. Callers are auth-gated fleet/local, so a generous ceiling is
  // acceptable here (this is not a public endpoint — see README).
  app.use(express.json({ limit: '25mb' }));

  // API routes
  app.use('/api/keys', keysRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/fallback', fallbackRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/agent', agentRouter);
  app.use('/api/capabilities', capabilitiesRouter);
  app.use('/api/canon', canonRouter);
  app.use('/api/model-perf', modelPerfRouter);

  // OpenAI-compatible proxy
  app.use('/v1', proxyRouter);

  // MCP (Model Context Protocol) — fleet agents query live routing state as tools.
  app.use('/mcp', mcpRouter);

  // Health check
  app.get('/api/ping', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Error handler (for API routes)
  app.use(errorHandler);

  // Serve client static files (after API error handler)
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  // SPA fallback — serve index.html for non-API routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  return app;
}
