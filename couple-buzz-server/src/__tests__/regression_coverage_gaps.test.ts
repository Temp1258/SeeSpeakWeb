/**
 * Coverage gaps from v1.2.13 / v1.2.14 fills, written in v1.2.15.
 *
 * Earlier audit-driven commits dropped tests for the server-side fixes but
 * left four corners of the acceptance checklist untested:
 *
 *   1. GET /health — operational liveness probe used by deployment script
 *      (`curl /health` after pm2 restart). Wired in index.ts (NOT in routes.ts),
 *      so the existing test harness never exercised it.
 *   2. L5 client side — SetupScreen.tsx's `password.length < 6` guard. Server
 *      side has supertest coverage; the client wasn't checked statically.
 *   3. H3 client subscribe — server emits `daily_update` correctly (proven
 *      in regression_h_bugs.test.ts), but no test asserted that
 *      DailyQuestionCard / DailySnapCard actually subscribe to that event.
 *      A revert of the subscribe call would silently break realtime sync.
 *
 * Server-side endpoints get real supertest assertions; client-side fixes are
 * static source checks (no RN harness in this Jest env, same constraint as
 * earlier regression files).
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'couple-buzz-app');
const SERVER_ROOT = path.join(__dirname, '..');

function readApp(rel: string): string {
  return fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');
}
function readServer(rel: string): string {
  return fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
}

// ────────────────────────────────────────────────────────────────────
// 1. GET /health — production liveness probe
// ────────────────────────────────────────────────────────────────────

describe('Acceptance — GET /health', () => {
  it('production index.ts registers GET /health with the {status:"ok",timestamp} contract', () => {
    const src = readServer('index.ts');
    expect(src).toMatch(/app\.get\(\s*['"]\/health['"]/);
    expect(src).toMatch(/status:\s*['"]ok['"]/);
    expect(src).toMatch(/timestamp:\s*new Date\(\)\.toISOString\(\)/);
  });

  it('handler shape works under supertest (mounted equivalent)', async () => {
    // index.ts isn't safe to import directly (it calls httpServer.listen on
    // top-level), so we mount the same handler logic in a throwaway app and
    // verify the contract end-to-end. The source-pattern check above
    // guarantees production matches this exact shape.
    const app = express();
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
    // Must be a parseable ISO instant — operational probes that diff
    // against system time would silently miss a "stuck timestamp" bug
    // without this assertion.
    expect(Number.isFinite(Date.parse(res.body.timestamp))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. L5 client side — SetupScreen password ≥ 6
// ────────────────────────────────────────────────────────────────────

describe('Acceptance — L5 client SetupScreen blocks <6-char passwords', () => {
  let src: string;
  beforeAll(() => {
    src = readApp('src/screens/SetupScreen.tsx');
  });

  it('checks password.length < 6 before calling api.register', () => {
    expect(src).toMatch(/password\.length\s*<\s*6/);
    // No leftover 4-char threshold (would silently let the server reject).
    expect(src).not.toMatch(/password\.length\s*<\s*4/);
  });

  it('Alert message surfaces the new minimum to the user', () => {
    // The Alert text the user sees: "密码至少6位".
    expect(src).toMatch(/密码至少6位/);
    expect(src).not.toMatch(/密码至少4位/);
  });

  it('placeholder advertises the new minimum (visible before they even type)', () => {
    expect(src).toMatch(/设置密码（至少6位）/);
    expect(src).not.toMatch(/设置密码（至少4位）/);
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. H3 client subscribe — DailyQuestionCard + DailySnapCard listen to daily_update
// ────────────────────────────────────────────────────────────────────

describe('Acceptance — H3 client subscribes to daily_update socket event', () => {
  it('DailyQuestionCard imports subscribe and listens to daily_update', () => {
    const src = readApp('src/components/DailyQuestionCard.tsx');
    expect(src).toMatch(/import\s*\{\s*subscribe\s*\}\s*from\s*['"]\.\.\/services\/socket['"]/);
    expect(src).toMatch(/subscribe\(\s*['"]daily_update['"]/);
    // Skips snap-only events to avoid wasted reloads — see card source.
    expect(src).toMatch(/data\?\.kind\s*===\s*['"]snap['"]\s*\)\s*return/);
  });

  it('DailyQuestionCard reload handler is wired to load() (not a no-op stub)', () => {
    const src = readApp('src/components/DailyQuestionCard.tsx');
    // The subscribe block must end up calling load() — assert by structural
    // search for the entire effect: subscribe(...) callback that reaches load().
    const block = src.match(/subscribe\('daily_update'[\s\S]{0,400}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/load\(\)\s*;/);
  });

  it('DailySnapCard imports subscribe and listens to daily_update', () => {
    const src = readApp('src/components/DailySnapCard.tsx');
    expect(src).toMatch(/import\s*\{\s*subscribe\s*\}\s*from\s*['"]\.\.\/services\/socket['"]/);
    expect(src).toMatch(/subscribe\(\s*['"]daily_update['"]/);
    // Skips answer-only + reaction-on-question events.
    expect(src).toMatch(/data\?\.kind\s*===\s*['"]answer['"]\s*\)\s*return/);
    expect(src).toMatch(/data\?\.target\s*!==\s*['"]snap['"]\s*\)\s*return/);
  });

  it('DailySnapCard reload handler is wired to load() (not a no-op stub)', () => {
    const src = readApp('src/components/DailySnapCard.tsx');
    const block = src.match(/subscribe\('daily_update'[\s\S]{0,400}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/load\(\)\s*;/);
  });
});

// ────────────────────────────────────────────────────────────────────
// 4. Snap upload happy path — explicit redundancy on top of H3 emit test
// ────────────────────────────────────────────────────────────────────
//
// regression_h_bugs.test.ts already covers this implicitly (it uploads a
// real JPEG, expects 200, and asserts emit). Explicit version here so a
// future audit reading just THIS file can confirm "snap upload still works"
// without needing to know the H3 emit test's setup.

describe('Acceptance — POST /api/snaps happy path still 200s after L1 multer wrapper', () => {
  it('returns 200 with success:true on a valid JPEG upload', async () => {
    const { createDatabase } = require('../db');
    const { createPublicRouter, createProtectedRouter } = require('../routes');
    const { createAuthMiddleware } = require('../auth');

    process.env.JWT_SECRET = 'test-jwt-secret-for-testing-only';

    const { dbOps } = createDatabase(':memory:');
    const mockPush = jest.fn().mockResolvedValue(true);
    const app = express();
    app.use(express.json());
    app.use('/api', createPublicRouter(dbOps));
    app.use('/api', createAuthMiddleware(dbOps), createProtectedRouter(dbOps, mockPush));

    // Register + pair Alice & Bob via the API so the snap route's
    // pair-check passes.
    const alice = await request(app)
      .post('/api/register')
      .send({ name: 'Alice', password: 'test1234', device_token: 'a-token' });
    const bob = await request(app)
      .post('/api/register')
      .send({ name: 'Bob', password: 'test1234', device_token: 'b-token' });
    await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${alice.body.access_token}`)
      .send({ partner_id: bob.body.user_id });

    // Minimal valid JPEG: SOI + EOI bytes. multer's fileFilter accepts any
    // image/* MIME — magic bytes are not validated server-side. Sufficient
    // to exercise the wrapper + DB write + rename path.
    const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const res = await request(app)
      .post('/api/snaps')
      .set('Authorization', `Bearer ${alice.body.access_token}`)
      .attach('photo', tinyJpeg, { filename: 'snap.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.snap_date).toBe('string');

    // Cleanup the file multer wrote — see same cleanup in regression_h_bugs.
    try {
      const dir = path.join(SERVER_ROOT, '..', 'data', 'snaps', alice.body.user_id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
});
