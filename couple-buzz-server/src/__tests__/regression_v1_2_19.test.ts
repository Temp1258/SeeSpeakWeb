/**
 * Regression tests for the v1.2.19 fixes:
 *
 *   #1 — Spurious "kicked back to login on bad network" caused by an
 *        overly tight 10 s rotation grace window. Real mobile networks
 *        regularly stretch a single round-trip past 10 s (subway /
 *        elevator / weak Wi-Fi), so a user whose refresh response was
 *        dropped at second N>10 was being rejected next launch with
 *        "Refresh token already used" (a 401 without session_revoked
 *        code → client clears storage → SetupScreen). Server grace
 *        bumped to 5 minutes; client App.tsx bootstrap also retries
 *        once on generic AuthError before giving up.
 *
 *   #2 — Login form ID field had no textContentType, so iOS Password
 *        AutoFill couldn't suggest the saved ID (it could autofill the
 *        password because secureTextEntry implies "password" but had
 *        nothing to associate the username with). Source-pattern check
 *        on SetupScreen.tsx that both fields now declare
 *        textContentType + autoComplete.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createDatabase } from '../db';
import { createPublicRouter, createProtectedRouter, SendPushFn } from '../routes';
import { createAuthMiddleware } from '../auth';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing-only';

function createTestApp() {
  const { db, dbOps } = createDatabase(':memory:');
  const mockPush: SendPushFn = jest.fn().mockResolvedValue(true);
  const app = express();
  app.use(express.json());
  const publicRouter = createPublicRouter(dbOps);
  const protectedRouter = createProtectedRouter(dbOps, mockPush);
  const authMiddleware = createAuthMiddleware(dbOps);
  app.use('/api', publicRouter);
  app.use('/api', authMiddleware, protectedRouter);
  return { app, db, dbOps };
}

async function registerUser(app: express.Express, name: string, password = 'test1234') {
  const res = await request(app)
    .post('/api/register')
    .send({ name, password });
  return res.body as {
    user_id: string;
    access_token: string;
    refresh_token: string;
  };
}

// Same SHA-256 hex hash routes.ts/auth.ts use to store refresh tokens.
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// SQLite-compatible "X seconds ago" UTC timestamp ("YYYY-MM-DD HH:MM:SS"),
// matching the format CURRENT_TIMESTAMP would have written. Used to
// backdate `superseded_at` for grace-window boundary tests so we don't
// have to actually wait minutes in real time.
function sqliteSecondsAgo(secondsAgo: number): string {
  const t = new Date(Date.now() - secondsAgo * 1000);
  return t.toISOString().slice(0, 19).replace('T', ' ');
}

// ────────────────────────────────────────────────────────────────────
// #1 — Server: refresh grace window extended to 5 minutes
// ────────────────────────────────────────────────────────────────────

describe('#1 — refresh-token rotation grace window (5 min)', () => {
  it('replay 60 s past supersede STILL succeeds (within the new grace)', async () => {
    const { app, db } = createTestApp();
    const user = await registerUser(app, 'Alice');

    // First refresh: server rotates, marks original as superseded_at=now.
    const first = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: user.refresh_token });
    expect(first.status).toBe(200);

    // Backdate the original token's supersede stamp by 60 s. Under the old
    // 10 s grace this would have been rejected; under the new 300 s grace
    // it must still be accepted.
    db.prepare('UPDATE refresh_tokens SET superseded_at = ? WHERE token_hash = ?')
      .run(sqliteSecondsAgo(60), hashToken(user.refresh_token));

    const replay = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: user.refresh_token });
    expect(replay.status).toBe(200);
    expect(replay.body.access_token).toBeTruthy();
    expect(replay.body.refresh_token).toBeTruthy();
  });

  it('replay 4 min past supersede still succeeds (mid-grace)', async () => {
    const { app, db } = createTestApp();
    const user = await registerUser(app, 'Alice');

    await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: user.refresh_token })
      .expect(200);

    db.prepare('UPDATE refresh_tokens SET superseded_at = ? WHERE token_hash = ?')
      .run(sqliteSecondsAgo(4 * 60), hashToken(user.refresh_token));

    const replay = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: user.refresh_token });
    expect(replay.status).toBe(200);
  });

  it('replay 301 s past supersede is rejected with "Refresh token already used"', async () => {
    // Boundary: 1 s past the 5 min grace must reject. This is the
    // ONE-WAY trip-wire that makes the grace bounded (not "forever").
    const { app, db } = createTestApp();
    const user = await registerUser(app, 'Alice');

    await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: user.refresh_token })
      .expect(200);

    db.prepare('UPDATE refresh_tokens SET superseded_at = ? WHERE token_hash = ?')
      .run(sqliteSecondsAgo(301), hashToken(user.refresh_token));

    const replay = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: user.refresh_token });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('Refresh token already used');
    // Crucially: this is NOT a session_revoked code, so client treats
    // it as generic 'auth'. Combined with bootstrap retry, the client
    // still gets one more shot before clearing the session.
    expect(replay.body.code).toBeUndefined();
  });

  it('a revoked session is rejected regardless of grace window timing', async () => {
    // The grace-window extension MUST NOT weaken the force-logout
    // guarantee: when another device revokes our session, our next
    // refresh must immediately get back code:session_revoked even if
    // we're well within the 5-min window.
    const { app, db, dbOps } = createTestApp();
    const user = await registerUser(app, 'Alice');

    // Rotate once so we have something superseded sitting around.
    await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: user.refresh_token })
      .expect(200);

    // Mark every refresh row for this user as revoked. Both the new
    // (active) row and the superseded original.
    db.prepare(
      'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?',
    ).run(user.user_id);

    // Backdate supersede to 30 s — well within grace.
    db.prepare('UPDATE refresh_tokens SET superseded_at = ? WHERE token_hash = ?')
      .run(sqliteSecondsAgo(30), hashToken(user.refresh_token));

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: user.refresh_token });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('session_revoked');
    void dbOps;
  });
});

// ────────────────────────────────────────────────────────────────────
// #1 — Client: bootstrap retry on generic AuthError
// ────────────────────────────────────────────────────────────────────

describe('#1 — App.tsx bootstrap retries once on generic AuthError', () => {
  const APP_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'App.tsx'),
    'utf8',
  );

  it('imports StatusResponse so the inline helpers can type the status arg', () => {
    expect(APP_SRC).toMatch(/import\s*\{[^}]*StatusResponse[^}]*\}\s*from\s*'\.\/src\/services\/api'/);
  });

  it('still early-returns + alerts on session_revoked (no retry delay for genuine kicks)', () => {
    // The session_revoked path must NOT go through the 2.5s retry,
    // otherwise users who were truly force-logged-out would wait extra
    // seconds before seeing the explanatory alert.
    const idx = APP_SRC.indexOf("error.code === 'session_revoked'");
    expect(idx).toBeGreaterThanOrEqual(0);
    const window = APP_SRC.slice(idx, idx + 400);
    expect(window).toMatch(/已退出登录/);
    expect(window).toMatch(/storage\.clearAll\(\)/);
    expect(window).toMatch(/setAppState\('setup'\)/);
  });

  it('waits 2.5 s and retries api.getStatus() once on a generic AuthError', () => {
    // The retry block sits inside the bootstrap catch; verify the
    // exact wait + second getStatus call exists.
    // `new Promise<void>((r) => setTimeout(r, 2500))` — resolver `r`
    // passed directly to setTimeout.
    expect(APP_SRC).toMatch(/setTimeout\(r,\s*2500\)/);
    // After the wait, the bootstrap must call getStatus again.
    const catchSlice = APP_SRC.split('catch (error)')[1] ?? '';
    const retryCount = (catchSlice.match(/api\.getStatus\(\)/g) ?? []).length;
    expect(retryCount).toBeGreaterThanOrEqual(1);
  });

  it('retry that throws AuthError clears storage; retry that throws network error falls back to cache', () => {
    const catchSlice = APP_SRC.split('catch (error)')[1] ?? '';
    // Nested catch on the retry leg must distinguish AuthError (clear)
    // from generic error (fall back to cache).
    expect(catchSlice).toMatch(/catch\s*\(\s*retryError\s*\)/);
    expect(catchSlice).toMatch(/retryError\s+instanceof\s+AuthError/);
    expect(catchSlice).toMatch(/fallbackToCachedOrWaiting/);
  });
});

// ────────────────────────────────────────────────────────────────────
// #2 — SetupScreen login form declares textContentType / autoComplete
// ────────────────────────────────────────────────────────────────────

describe('#2 — login form drives iOS Password AutoFill for the ID field', () => {
  const SETUP_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'screens', 'SetupScreen.tsx'),
    'utf8',
  );

  it('the loginId TextInput declares textContentType="username"', () => {
    // Match the loginId TextInput specifically (placeholder 你的 ID, value=loginId).
    const idx = SETUP_SRC.indexOf('value={loginId}');
    expect(idx).toBeGreaterThanOrEqual(0);
    // Inspect a window around the loginId field — props can be on the
    // same JSX element across multiple lines.
    const fieldSlice = SETUP_SRC.slice(Math.max(0, idx - 200), idx + 400);
    expect(fieldSlice).toMatch(/textContentType=["']username["']/);
    expect(fieldSlice).toMatch(/autoComplete=["']username["']/);
  });

  it('the loginPassword TextInput declares textContentType="password"', () => {
    const idx = SETUP_SRC.indexOf('value={loginPassword}');
    expect(idx).toBeGreaterThanOrEqual(0);
    const fieldSlice = SETUP_SRC.slice(Math.max(0, idx - 200), idx + 400);
    expect(fieldSlice).toMatch(/textContentType=["']password["']/);
    expect(fieldSlice).toMatch(/autoComplete=["']password["']/);
  });

  it('loginId preserves uppercase normalization so autofilled lowercase still works', () => {
    // handleLogin still calls .trim().toUpperCase() — guarantees that
    // any autofilled string (even from a corrupted Keychain entry) gets
    // normalized before hitting the server.
    expect(SETUP_SRC).toMatch(/api\.login\(\s*loginId\.trim\(\)\.toUpperCase\(\)/);
  });
});
