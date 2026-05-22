/**
 * Regression tests for v1.3.1:
 *
 *   #1 — Same-emoji burst pushes now collapse server-side via APNs
 *        collapse-id + count-suffixed body. Mirrors the v1.2.20 client
 *        ×NN bubble: A spams 5 💋 at offline B → B's lock screen shows
 *        ONE notification, body reading "... ×5".
 *
 *   #2 — GET /api/history accepts `before_id` cursor and returns
 *        `has_more`. Drives the "scroll to top of 废话区 to load older
 *        messages" flow in HistoryScreen.
 *
 *   #3 — SnapCalendarScreen wraps its grid in a Pressable that calls
 *        onClose, so a tap on the empty area around the cells dismisses
 *        the modal (mirroring InboxScreen's listWrap pattern).
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createDatabase } from '../db';
import { createPublicRouter, createProtectedRouter, SendPushFn } from '../routes';
import { createAuthMiddleware } from '../auth';
import { _resetBurstsForTesting } from '../bursts';

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
  return { app, db, dbOps, mockPush };
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

beforeEach(() => {
  // Burst tracker is module-level state shared across tests in the same
  // jest worker. Wipe between cases so prior emoji counts don't bleed.
  _resetBurstsForTesting();
});

// ────────────────────────────────────────────────────────────────────
// #1 — Burst push collapse
// ────────────────────────────────────────────────────────────────────

describe('#1 — emoji-burst push collapses with APNs collapse-id + ×N body', () => {
  it('first emoji of a burst sends with no bodyOverride (count=1 uses template)', async () => {
    const { app, mockPush } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'kiss' });

    // pushFn signature on the 1st-in-burst call:
    //   (token, type, name, extra=undefined, badge, collapseId)
    // i.e. 6 positional args — no bodyOverride yet.
    const call = (mockPush as jest.Mock).mock.calls[0];
    expect(call).toHaveLength(6);
    expect(call[1]).toBe('kiss');
    expect(call[2]).toBe('Alice');
    expect(call[5]).toMatch(/^burst-/); // stable collapseId for the burst
  });

  it('2nd+ emoji in the same burst sends a count-suffixed bodyOverride', async () => {
    const { app, mockPush } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/action')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ action_type: 'kiss' });
    }

    const calls = (mockPush as jest.Mock).mock.calls;
    expect(calls).toHaveLength(3);
    // 1st call: no bodyOverride (count=1)
    expect(calls[0]).toHaveLength(6);
    // 2nd, 3rd: bodyOverride is positional arg #7, ends with " ×N"
    expect(calls[1]).toHaveLength(7);
    expect(calls[1][6]).toMatch(/×2$/);
    expect(calls[2]).toHaveLength(7);
    expect(calls[2][6]).toMatch(/×3$/);
  });

  it('all bursts in the same chain share the SAME collapseId so iOS lock-screen merges', async () => {
    const { app, mockPush } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/action')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ action_type: 'kiss' });
    }

    const collapseIds = (mockPush as jest.Mock).mock.calls.map((c) => c[5]);
    expect(new Set(collapseIds).size).toBe(1);
  });

  it('different emoji types are separate bursts (kiss spam doesnt eat into a hug)', async () => {
    const { app, mockPush } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'kiss' });
    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'kiss' });
    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'hug' });
    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'kiss' });

    const calls = (mockPush as jest.Mock).mock.calls;
    expect(calls).toHaveLength(4);
    // kiss collapseId (calls 0,1,3) all equal; hug collapseId (call 2) differs.
    expect(calls[0][5]).toBe(calls[1][5]);
    expect(calls[0][5]).toBe(calls[3][5]);
    expect(calls[2][5]).not.toBe(calls[0][5]);
    // The kiss bodies show 1, 2, then 3 (NOT 2 — hug interrupted but the
    // kiss burst is per-action_type so it continues counting).
    expect(calls[1][6]).toMatch(/×2$/);
    expect(calls[3][6]).toMatch(/×3$/);
  });

  it('bursts to different recipients are tracked independently', async () => {
    const { app, mockPush } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const bob = await registerUser(app, 'Bob');
    await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_id: bob.user_id });

    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'kiss' });
    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'kiss' });
    // Bob → Alice should be a fresh burst (different recipient).
    await request(app).post('/api/action').set('Authorization', `Bearer ${bob.access_token}`).send({ action_type: 'kiss' });

    const calls = (mockPush as jest.Mock).mock.calls;
    // Alice → Bob: calls 0, 1 (collapseId X, counts 1 / 2)
    // Bob → Alice: call 2 (collapseId Y, count 1)
    expect(calls[0][5]).toBe(calls[1][5]);
    expect(calls[2][5]).not.toBe(calls[0][5]);
    expect(calls[2]).toHaveLength(6); // no bodyOverride — fresh burst
  });

  it('history badge is set per-recipient (badge keeps incrementing across the burst)', async () => {
    const { app, mockPush } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/action')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ action_type: 'kiss' });
    }
    const badges = (mockPush as jest.Mock).mock.calls.map((c) => c[4]);
    expect(badges).toEqual([1, 2, 3]);
  });
});

// ────────────────────────────────────────────────────────────────────
// #2 — History pagination (server)
// ────────────────────────────────────────────────────────────────────

describe('#2 — GET /api/history supports before_id cursor + has_more', () => {
  async function seedHistory(
    app: express.Express,
    dbOps: ReturnType<typeof createTestApp>['dbOps'],
    aliceId: string,
    bobId: string,
    count: number,
  ) {
    const pairId = dbOps.couplesGetActivePairId(aliceId, bobId)!;
    for (let i = 0; i < count; i++) {
      dbOps.addAction(bobId, pairId, 'kiss', 'UTC', 'Bob');
    }
  }

  it('first page (no cursor) returns the newest `limit` actions + has_more=true when capped', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    await seedHistory(app, dbOps, alice.user_id, bob.user_id, 30);

    const res = await request(app)
      .get('/api/history?limit=10')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(10);
    expect(res.body.has_more).toBe(true);
    // Server returns DESC by created_at; oldest id in the slice should
    // be the floor of the page (= the cursor for the next page).
    const ids = (res.body.actions as Array<{ id: number }>).map((a) => a.id);
    expect(ids[0]).toBeGreaterThan(ids[ids.length - 1]);
  });

  it('before_id cursor returns strictly older actions', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    await seedHistory(app, dbOps, alice.user_id, bob.user_id, 25);

    const page1 = await request(app)
      .get('/api/history?limit=10')
      .set('Authorization', `Bearer ${alice.access_token}`);
    const earliestInPage1 = Math.min(
      ...(page1.body.actions as Array<{ id: number }>).map((a) => a.id),
    );

    const page2 = await request(app)
      .get(`/api/history?limit=10&before_id=${earliestInPage1}`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(page2.status).toBe(200);
    expect(page2.body.actions).toHaveLength(10);
    expect(
      (page2.body.actions as Array<{ id: number }>).every((a) => a.id < earliestInPage1),
    ).toBe(true);
    expect(page2.body.has_more).toBe(true);
  });

  it('paginating past the oldest entry returns [] and has_more=false', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    await seedHistory(app, dbOps, alice.user_id, bob.user_id, 5);

    const page1 = await request(app)
      .get('/api/history?limit=10')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(page1.body.actions).toHaveLength(5);
    // Server hit `actions.length === cappedLimit` (5 < 10) ⇒ has_more=false
    expect(page1.body.has_more).toBe(false);

    // For good measure: paginating before the oldest id returns empty.
    const earliest = Math.min(
      ...(page1.body.actions as Array<{ id: number }>).map((a) => a.id),
    );
    const beforeEarliest = await request(app)
      .get(`/api/history?limit=10&before_id=${earliest}`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(beforeEarliest.body.actions).toHaveLength(0);
    expect(beforeEarliest.body.has_more).toBe(false);
  });

  it('unpaired user gets empty + has_more=false (no leak from a previous pair_id)', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const res = await request(app)
      .get('/api/history?limit=10')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual([]);
    expect(res.body.has_more).toBe(false);
  });

  it('cursor + 2 pages cover ALL history without overlap or gap', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    await seedHistory(app, dbOps, alice.user_id, bob.user_id, 17);

    const page1 = await request(app)
      .get('/api/history?limit=10')
      .set('Authorization', `Bearer ${alice.access_token}`);
    const earliest1 = Math.min(
      ...(page1.body.actions as Array<{ id: number }>).map((a) => a.id),
    );
    const page2 = await request(app)
      .get(`/api/history?limit=10&before_id=${earliest1}`)
      .set('Authorization', `Bearer ${alice.access_token}`);

    const allIds = new Set<number>([
      ...(page1.body.actions as Array<{ id: number }>).map((a) => a.id),
      ...(page2.body.actions as Array<{ id: number }>).map((a) => a.id),
    ]);
    expect(allIds.size).toBe(17); // no dupes, no missing
  });
});

// ────────────────────────────────────────────────────────────────────
// #2 — Client HistoryScreen wires pagination
// ────────────────────────────────────────────────────────────────────

describe('#2 — HistoryScreen wires pagination', () => {
  const HIST_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'screens', 'HistoryScreen.tsx'),
    'utf8',
  );

  it('keeps a flat rawActions state instead of pre-grouped sections', () => {
    expect(HIST_SRC).toMatch(/const\s+\[rawActions,\s*setRawActions\]/);
    // sections derived via useMemo, not stored.
    expect(HIST_SRC).toMatch(/const\s+sections\s*=\s*useMemo/);
  });

  it('defines loadOlder + tracks earliestId + loadingOlder ref', () => {
    expect(HIST_SRC).toMatch(/const\s+loadOlder\s*=\s*useCallback/);
    expect(HIST_SRC).toMatch(/earliestIdRef/);
    expect(HIST_SRC).toMatch(/loadingOlderRef/);
  });

  it('loadOlder calls api.getHistory(50, cursor) with the earliest-id cursor', () => {
    expect(HIST_SRC).toMatch(/api\.getHistory\(50,\s*earliestIdRef\.current\)/);
  });

  it('onScroll triggers loadOlder when within 80pt of the top', () => {
    expect(HIST_SRC).toMatch(/contentOffset\.y\s*<\s*80/);
  });

  it('SectionList sets maintainVisibleContentPosition so prepend doesnt jump', () => {
    expect(HIST_SRC).toMatch(/maintainVisibleContentPosition=\{\{[^}]*minIndexForVisible/);
  });

  it('ListHeaderComponent shows loading / exhaustion hint based on hasMore + loadingOlder', () => {
    expect(HIST_SRC).toMatch(/ListHeaderComponent=/);
    expect(HIST_SRC).toMatch(/已经是最早的一条了/);
  });

  it('scrollToBottom only fires when latestId actually grew (no jump after prepend)', () => {
    expect(HIST_SRC).toMatch(/latestIdRef\.current\s*>\s*prevLatestIdRef\.current/);
    expect(HIST_SRC).toMatch(/isAtBottomRef/);
  });
});

// ────────────────────────────────────────────────────────────────────
// #3 — SnapCalendar tap-to-close
// ────────────────────────────────────────────────────────────────────

describe('#3 — SnapCalendarScreen empty-area tap dismisses the modal', () => {
  const SC_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'screens', 'SnapCalendarScreen.tsx'),
    'utf8',
  );

  it('wraps the grid ScrollView in a Pressable with onPress={onClose}', () => {
    // The Pressable owns the gridArea — taps that miss every cell
    // (gap, padding, empty-month area) bubble up to it.
    expect(SC_SRC).toMatch(/<Pressable\s+style=\{styles\.gridArea\}\s+onPress=\{onClose\}/);
  });

  it('declares the gridArea style alongside the existing grid styles', () => {
    expect(SC_SRC).toMatch(/gridArea:\s*\{[\s\S]*?flex:\s*1/);
  });

  it('cells still own their own onPress (so tapping a snap opens the preview, not the dismiss)', () => {
    // Cell TouchableOpacity is inside the Pressable; its onPress fires
    // before the outer Pressable, so tapping a snap shouldn't close.
    expect(SC_SRC).toMatch(/<TouchableOpacity[\s\S]*?onPress=\{\(\)\s*=>\s*onCellTap\(snap\)\}/);
  });
});
