/**
 * Regression tests for v1.2.21:
 *
 *   A2 — Long-press-to-react feature fully removed
 *        - POST /api/reaction route deleted
 *        - dbOps.addReaction / getReaction / updateReaction /
 *          getHistoryReactions removed
 *        - reactions{} no longer built in GET /api/history
 *        - 'reaction' push template gone
 *        - Client: api.sendReaction / ReactionResponse / ReactionPicker
 *          file / ActionRecord.onLongPress / .reactions all stripped
 *
 *   A3 — 信箱 → 「📷 快照日历」 entry added below 小贴吧
 *        Opens SnapCalendarScreen modal (pageSheet), reads from existing
 *        GET /api/snaps?month=YYYY-MM endpoint.
 *
 *   Cleanup — Verified-dead methods removed:
 *        client api.openCapsule, api.logout
 *        server dbOps.pairUsers / unpairUsers / getSession / getRituals /
 *          getAllPairedUserTokens / saveSnap
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
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
    .send({ name, password, device_token: `${name}-token` });
  return res.body as { user_id: string; access_token: string; refresh_token: string };
}

async function registerPairedUsers(app: express.Express) {
  const alice = await registerUser(app, 'Alice');
  const bob = await registerUser(app, 'Bob');
  await request(app)
    .post('/api/pair')
    .set('Authorization', `Bearer ${alice.access_token}`)
    .send({ partner_id: bob.user_id });
  return { alice, bob };
}

// ────────────────────────────────────────────────────────────────────
// A2 — Reaction feature fully removed (server)
// ────────────────────────────────────────────────────────────────────

describe('A2 — POST /api/reaction is gone', () => {
  it('POST /api/reaction returns 404', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    const res = await request(app)
      .post('/api/reaction')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_id: 1, action_type: 'kiss' });
    expect(res.status).toBe(404);
  });

  it('GET /api/history returns reactions as an empty object (compat shim)', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ action_type: 'miss' });
    const res = await request(app)
      .get('/api/history')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(1);
    // Compat shim: older OTA bundles still read `result.reactions || {}`,
    // so the field is present-but-empty for one release cycle.
    expect(res.body.reactions).toEqual({});
  });

  it('dbOps no longer exposes message-reaction helpers', () => {
    const { dbOps } = createTestApp();
    expect((dbOps as unknown as { addReaction?: unknown }).addReaction).toBeUndefined();
    expect((dbOps as unknown as { getReaction?: unknown }).getReaction).toBeUndefined();
    expect((dbOps as unknown as { updateReaction?: unknown }).updateReaction).toBeUndefined();
    expect((dbOps as unknown as { getHistoryReactions?: unknown }).getHistoryReactions).toBeUndefined();
  });

  it('actions.reply_to column still exists (DB schema unchanged)', () => {
    // SQLite drop-column is a table-rebuild; we intentionally keep the
    // column so existing orphan reaction rows don't crash any startup
    // probe. The query that drives /api/history filters them out.
    const { db } = createTestApp();
    const cols = db.prepare("PRAGMA table_info(actions)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'reply_to')).toBe(true);
  });

  it('daily-reaction (the SEPARATE endpoint) still works', async () => {
    // /api/daily-reaction is for 👍/👎 on the daily question + snap.
    // Different endpoint, different DB tables, must remain functional.
    // Pre-req: both partners must have answered today's question.
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    await request(app)
      .post('/api/daily-question/answer')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ answer: 'bob-answer' });
    await request(app)
      .post('/api/daily-question/answer')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ answer: 'alice-answer' });
    const res = await request(app)
      .post('/api/daily-reaction')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ type: 'question', reaction: 'up' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('A2 — push templates no longer carry `reaction`', () => {
  const PUSH_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', 'push.ts'),
    'utf8',
  );

  it('PUSH_MESSAGES does NOT declare a `reaction` key', () => {
    // Match exactly `  reaction:` at start of a line — the keys are
    // 2-space-indented dictionary entries. react_question_up / etc.
    // are NOT this key.
    expect(PUSH_SRC).not.toMatch(/^\s{2}reaction:\s*\{/m);
  });
});

// ────────────────────────────────────────────────────────────────────
// A2 — client-side artifacts gone
// ────────────────────────────────────────────────────────────────────

describe('A2 — client artifacts removed', () => {
  it('ReactionPicker.tsx file is deleted', () => {
    const p = path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'components', 'ReactionPicker.tsx');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('api.ts has no `sendReaction` method', () => {
    const apiSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'services', 'api.ts'),
      'utf8',
    );
    expect(apiSrc).not.toMatch(/sendReaction\(/);
  });

  it('ActionRecord.tsx has no `onLongPress` or `reactions` prop', () => {
    const arSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'components', 'ActionRecord.tsx'),
      'utf8',
    );
    expect(arSrc).not.toMatch(/onLongPress\??:\s*\(\)\s*=>\s*void/);
    expect(arSrc).not.toMatch(/reactions\??:\s*HistoryAction\[\]/);
    // The ×NN burst-collapse machinery (v1.2.20) must still be present.
    expect(arSrc).toMatch(/count\??:\s*number/);
    expect(arSrc).toMatch(/prevCountRef/);
  });

  it('HistoryScreen.tsx no longer keeps a `reactions` state', () => {
    const hsSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'screens', 'HistoryScreen.tsx'),
      'utf8',
    );
    expect(hsSrc).not.toMatch(/setReactions\(/);
    expect(hsSrc).not.toMatch(/reactions=\{reactions\[item\.id\]\}/);
  });
});

// ────────────────────────────────────────────────────────────────────
// A3 — Snap calendar wired into MailboxScreen
// ────────────────────────────────────────────────────────────────────

describe('A3 — 信箱 has 快照日历 entry that opens SnapCalendarScreen', () => {
  const MAILBOX_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'screens', 'MailboxScreen.tsx'),
    'utf8',
  );
  const SCREEN_PATH = path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'screens', 'SnapCalendarScreen.tsx');
  const SCREEN_SRC = fs.readFileSync(SCREEN_PATH, 'utf8');

  it('MailboxScreen imports SnapCalendarScreen + SnapCalendarHandle', () => {
    expect(MAILBOX_SRC).toMatch(/import\s+SnapCalendarScreen,\s*\{\s*SnapCalendarHandle\s*\}\s+from\s+'\.\/SnapCalendarScreen'/);
  });

  it('MailboxScreen renders the 快照日历 entry card', () => {
    expect(MAILBOX_SRC).toMatch(/快照日历/);
    expect(MAILBOX_SRC).toMatch(/onPress=\{\(\)\s*=>\s*setSnapCalendarOpen\(true\)\}/);
  });

  it('MailboxScreen mounts <SnapCalendarScreen visible onClose ref/>', () => {
    expect(MAILBOX_SRC).toMatch(/<SnapCalendarScreen[\s\S]+visible=\{snapCalendarOpen\}/);
    expect(MAILBOX_SRC).toMatch(/setSnapCalendarOpen\(false\)/);
  });

  it('onRefresh forwards reload to the snap-calendar handle', () => {
    expect(MAILBOX_SRC).toMatch(/snapCalendarRef\.current\?\.reload\(\)/);
  });

  it('SnapCalendarScreen.tsx exists and forwardRefs a reload-style handle', () => {
    expect(SCREEN_SRC).toMatch(/forwardRef<SnapCalendarHandle/);
    expect(SCREEN_SRC).toMatch(/reload:\s*\(\)\s*=>\s*Promise<void>/);
  });

  it('SnapCalendarScreen uses the existing /api/snaps endpoint (no schema/route change)', () => {
    expect(SCREEN_SRC).toMatch(/api\.getSnaps\(/);
  });

  it('SnapCalendarScreen falls back to current month on every open', () => {
    expect(SCREEN_SRC).toMatch(/setCurrentMonth\(monthKey\(new Date\(\)\)\)/);
  });

  it('SnapCalendarScreen has month switcher arrows', () => {
    expect(SCREEN_SRC).toMatch(/shiftMonth\(m,\s*-1\)/);
    expect(SCREEN_SRC).toMatch(/shiftMonth\(m,\s*1\)/);
  });
});

describe('A3 — GET /api/snaps?month= still serves the calendar data', () => {
  it('returns snap entries for a month with both partners snapped', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const date = '2026-05-10';
    dbOps.saveSnapAtomic(bob.user_id, alice.user_id, date, `${bob.user_id}/${date}.jpg`);
    dbOps.saveSnapAtomic(alice.user_id, bob.user_id, date, `${alice.user_id}/${date}.jpg`);

    const res = await request(app)
      .get('/api/snaps?month=2026-05')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body.snaps).toHaveLength(1);
    expect(res.body.snaps[0].date).toBe(date);
    expect(res.body.snaps[0].both_snapped).toBe(true);
    expect(res.body.snaps[0].my_photo).toBeTruthy();
    expect(res.body.snaps[0].partner_photo).toBeTruthy();
  });

  it('hides partner photo when caller never snapped that day (anti-peek)', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const date = '2026-05-11';
    dbOps.saveSnapAtomic(bob.user_id, alice.user_id, date, `${bob.user_id}/${date}.jpg`);

    const res = await request(app)
      .get('/api/snaps?month=2026-05')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body.snaps).toHaveLength(1);
    expect(res.body.snaps[0].both_snapped).toBe(false);
    expect(res.body.snaps[0].my_photo).toBeNull();
    expect(res.body.snaps[0].partner_photo).toBeNull(); // anti-peek
  });

  it('rejects malformed month strings', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    const bad = await request(app)
      .get('/api/snaps?month=2026-13')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(bad.status).toBe(400);
  });

  // ── Anti-peek — exhaustive scenarios from BOTH sides ─────────────────
  // The reveal rule: a day's photo URLs are only delivered when the
  // caller has ALSO snapped that same day. So:
  //   only ta snapped → I see nothing (anti-peek); ta sees own only
  //   only I snapped  → ta sees nothing; I see own only
  //   both snapped     → both see both
  // Below tests verify each case from BOTH sides (server is the source
  // of truth for visibility, not the client).

  it('anti-peek: only ta snapped — I see nothing, ta sees ta`s own', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const date = '2026-05-15';
    // Bob (= "ta" from Alice's POV) snaps.
    dbOps.saveSnapAtomic(bob.user_id, alice.user_id, date, `${bob.user_id}/${date}.jpg`);

    const aliceView = await request(app)
      .get('/api/snaps?month=2026-05')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(aliceView.body.snaps).toHaveLength(1);
    expect(aliceView.body.snaps[0].date).toBe(date);
    expect(aliceView.body.snaps[0].both_snapped).toBe(false);
    expect(aliceView.body.snaps[0].my_photo).toBeNull(); // Alice didn't snap
    expect(aliceView.body.snaps[0].partner_photo).toBeNull(); // anti-peek

    const bobView = await request(app)
      .get('/api/snaps?month=2026-05')
      .set('Authorization', `Bearer ${bob.access_token}`);
    expect(bobView.body.snaps).toHaveLength(1);
    expect(bobView.body.snaps[0].both_snapped).toBe(false);
    expect(bobView.body.snaps[0].my_photo).toBeTruthy(); // Bob sees his own
    expect(bobView.body.snaps[0].partner_photo).toBeNull(); // Alice hasn't snapped yet
  });

  it('anti-peek: only I snapped — ta sees nothing, I see my own', async () => {
    // Mirror case of the previous test, from the opposite POV.
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const date = '2026-05-20';
    dbOps.saveSnapAtomic(alice.user_id, bob.user_id, date, `${alice.user_id}/${date}.jpg`);

    const bobView = await request(app)
      .get('/api/snaps?month=2026-05')
      .set('Authorization', `Bearer ${bob.access_token}`);
    expect(bobView.body.snaps).toHaveLength(1);
    expect(bobView.body.snaps[0].both_snapped).toBe(false);
    expect(bobView.body.snaps[0].my_photo).toBeNull();
    expect(bobView.body.snaps[0].partner_photo).toBeNull(); // anti-peek

    const aliceView = await request(app)
      .get('/api/snaps?month=2026-05')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(aliceView.body.snaps).toHaveLength(1);
    expect(aliceView.body.snaps[0].both_snapped).toBe(false);
    expect(aliceView.body.snaps[0].my_photo).toBeTruthy();
    expect(aliceView.body.snaps[0].partner_photo).toBeNull();
  });

  it('anti-peek: once both snap, both photos unlock for both partners', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const date = '2026-05-21';
    dbOps.saveSnapAtomic(bob.user_id, alice.user_id, date, `${bob.user_id}/${date}.jpg`);
    dbOps.saveSnapAtomic(alice.user_id, bob.user_id, date, `${alice.user_id}/${date}.jpg`);

    for (const who of [alice, bob]) {
      const view = await request(app)
        .get('/api/snaps?month=2026-05')
        .set('Authorization', `Bearer ${who.access_token}`);
      expect(view.body.snaps).toHaveLength(1);
      expect(view.body.snaps[0].both_snapped).toBe(true);
      expect(view.body.snaps[0].my_photo).toBeTruthy();
      expect(view.body.snaps[0].partner_photo).toBeTruthy();
    }
  });

  it('anti-peek is per-day: snapping ONE day does not retroactively unlock OTHER days', async () => {
    // Subtle attack vector: if I snap on day X, do I unlock ta's day Y
    // photos too? Answer must be NO — anti-peek is a per-day check.
    // Build a month where ta snapped two days, I only snapped one of
    // them. Only the "both" day should expose ta's photo.
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const dayOnlyBob = '2026-05-25';
    const dayBoth = '2026-05-26';

    dbOps.saveSnapAtomic(bob.user_id, alice.user_id, dayOnlyBob, `${bob.user_id}/${dayOnlyBob}.jpg`);
    dbOps.saveSnapAtomic(bob.user_id, alice.user_id, dayBoth, `${bob.user_id}/${dayBoth}.jpg`);
    dbOps.saveSnapAtomic(alice.user_id, bob.user_id, dayBoth, `${alice.user_id}/${dayBoth}.jpg`);

    const aliceView = await request(app)
      .get('/api/snaps?month=2026-05')
      .set('Authorization', `Bearer ${alice.access_token}`);
    type SnapRow = {
      date: string;
      my_photo: string | null;
      partner_photo: string | null;
      both_snapped: boolean;
    };
    const byDate = Object.fromEntries(
      (aliceView.body.snaps as SnapRow[]).map((s) => [s.date, s]),
    ) as Record<string, SnapRow>;

    // Day Alice never snapped: must NOT leak Bob's photo.
    expect(byDate[dayOnlyBob].both_snapped).toBe(false);
    expect(byDate[dayOnlyBob].my_photo).toBeNull();
    expect(byDate[dayOnlyBob].partner_photo).toBeNull();

    // Day BOTH snapped: Bob's photo unlocked.
    expect(byDate[dayBoth].both_snapped).toBe(true);
    expect(byDate[dayBoth].my_photo).toBeTruthy();
    expect(byDate[dayBoth].partner_photo).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────
// Dead code — confirmed removed
// ────────────────────────────────────────────────────────────────────

describe('Cleanup — dead code removed', () => {
  it('dbOps no longer exposes pairUsers / unpairUsers / getSession / getRituals / getAllPairedUserTokens / saveSnap', () => {
    const { dbOps } = createTestApp();
    const probe = dbOps as unknown as Record<string, unknown>;
    expect(probe.pairUsers).toBeUndefined();
    expect(probe.unpairUsers).toBeUndefined();
    expect(probe.getSession).toBeUndefined();
    expect(probe.getRituals).toBeUndefined();
    expect(probe.getAllPairedUserTokens).toBeUndefined();
    expect(probe.saveSnap).toBeUndefined();
  });

  it('client api.ts no longer exposes openCapsule / logout', () => {
    const apiSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'services', 'api.ts'),
      'utf8',
    );
    expect(apiSrc).not.toMatch(/^\s+openCapsule\(/m);
    expect(apiSrc).not.toMatch(/^\s+logout\(\)/m);
  });

  it('the actively-used pair / unpair flow (pairCouple / unpairCouple) is intact', async () => {
    // We removed pairUsers / unpairUsers (the wrapper-less old version)
    // but the actual route flow uses pairCouple / unpairCouple. Smoke-
    // test by walking through pair → unpair → repair.
    const { app, dbOps } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const bob = await registerUser(app, 'Bob');
    await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_id: bob.user_id })
      .expect(200);
    expect(dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)).toBeTruthy();
    await request(app)
      .post('/api/unpair')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .expect(200);
    expect(dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)).toBeNull();
  });
});
