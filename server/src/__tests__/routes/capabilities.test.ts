import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run, get } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// Generic capability-reporting endpoint (2026-07-08, Adam's architecture
// directive): an external caller (Hermes, a consumer backend's own tooling) reports
// a real measured capability fact for a model, without feeder needing to
// know what the capability MEANS or run the probe itself. This is what lets
// consumer-specific probes (privileged_write hitting a consumer backend's REST API)
// live in the consumer's own codebase instead of feeder's core.
describe('Generic capability-reporting API', () => {
  let app: Express;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
    app = createApp();
  });

  afterAll(async () => {
    await closeDb();
    await drop();
  });

  beforeEach(async () => {
    await run(getPool(), 'DELETE FROM model_capabilities');
  });

  it('records a new capability fact for a real catalog model', async () => {
    const model = await get<{ platform: string; model_id: string }>(getPool(), 'SELECT platform, model_id FROM models LIMIT 1');

    const { status, body } = await request(app, 'POST', '/api/capabilities', {
      platform: model!.platform,
      model_id: model!.model_id,
      capability: 'privileged_write',
      supported: true,
      evidence: 'external probe run by Hermes against a consumer backend',
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ platform: model!.platform, model_id: model!.model_id, capability: 'privileged_write', supported: true });

    const row = await get<{ supported: boolean; source: string }>(getPool(), `
      SELECT mc.supported, mc.source FROM model_capabilities mc
      JOIN models m ON m.id = mc.model_db_id
      WHERE m.platform = ? AND m.model_id = ? AND mc.capability = 'privileged_write'
    `, [model!.platform, model!.model_id]);
    expect(row?.supported).toBe(true);
    expect(row?.source).toBe('measured'); // external reports are epistemically 'measured', never 'declared'
  });

  it('upserts (does not duplicate) when reported again for the same model+capability', async () => {
    const model = await get<{ platform: string; model_id: string }>(getPool(), 'SELECT platform, model_id FROM models LIMIT 1');

    await request(app, 'POST', '/api/capabilities', { platform: model!.platform, model_id: model!.model_id, capability: 'privileged_write', supported: false });
    await request(app, 'POST', '/api/capabilities', { platform: model!.platform, model_id: model!.model_id, capability: 'privileged_write', supported: true });

    const rows = await getPool().query(`
      SELECT mc.supported FROM model_capabilities mc
      JOIN models m ON m.id = mc.model_db_id
      WHERE m.platform = $1 AND m.model_id = $2 AND mc.capability = 'privileged_write'
    `, [model!.platform, model!.model_id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].supported).toBe(true); // latest report wins
  });

  it('404s when the model does not exist in the catalog', async () => {
    const { status } = await request(app, 'POST', '/api/capabilities', {
      platform: 'nonexistent-platform',
      model_id: 'nonexistent-model',
      capability: 'privileged_write',
      supported: true,
    });
    expect(status).toBe(404);
  });

  it('GET returns reported capabilities for a model', async () => {
    const model = await get<{ platform: string; model_id: string }>(getPool(), 'SELECT platform, model_id FROM models LIMIT 1');
    await request(app, 'POST', '/api/capabilities', { platform: model!.platform, model_id: model!.model_id, capability: 'privileged_write', supported: true });

    const { status, body } = await request(app, 'GET', `/api/capabilities?platform=${model!.platform}&model_id=${encodeURIComponent(model!.model_id)}`);
    expect(status).toBe(200);
    expect(body.capabilities).toContainEqual(expect.objectContaining({ capability: 'privileged_write', supported: true }));
  });
});
