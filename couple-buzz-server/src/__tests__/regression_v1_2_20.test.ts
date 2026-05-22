/**
 * Regression tests for v1.2.20:
 *
 *   REQ #1 — Same-emoji same-sender bursts within 5 min collapse into a
 *            single 废话区 bubble with a ×NN badge. Implemented purely
 *            client-side in HistoryScreen / ActionRecord; the server
 *            keeps storing every action row so badges / streak / weekly
 *            report stay accurate.
 *
 *   REQ #2 — Long-press the 废话区 header title to rename it (per-user,
 *            stored on the server, persists across logout / reinstall).
 *            New users.history_title column; PUT /api/profile +
 *            GET /api/status carry the field.
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
    .send({ name, password });
  return res.body as {
    user_id: string;
    access_token: string;
    refresh_token: string;
  };
}

// ────────────────────────────────────────────────────────────────────
// Server — history_title field on /profile + /status
// ────────────────────────────────────────────────────────────────────

describe('REQ #2 — history_title persists per user via /profile + /status', () => {
  it('GET /api/status returns history_title (empty by default)', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const res = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body.history_title).toBe('');
  });

  it('PUT /api/profile with history_title trims + persists; subsequent /status reflects it', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const put = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ history_title: '  我俩的小天地  ' });
    expect(put.status).toBe(200);
    expect(put.body.history_title).toBe('我俩的小天地');

    const status = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(status.body.history_title).toBe('我俩的小天地');
  });

  it('PUT /api/profile without history_title leaves the stored value alone', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ history_title: '🌙 月亮的家' })
      .expect(200);

    // A subsequent profile update that only touches name must NOT
    // wipe history_title back to '' — existing callers (SettingsScreen)
    // that pre-date v1.2.20 don't send the field.
    await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ name: 'Alice2' })
      .expect(200);

    const status = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(status.body.history_title).toBe('🌙 月亮的家');
    expect(status.body.name).toBe('Alice2');
  });

  it('PUT /api/profile rejects history_title that exceeds 30 chars (trimmed)', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const tooLong = 'a'.repeat(31);
    const put = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ history_title: tooLong });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/history_title/);
  });

  it('PUT /api/profile rejects non-string history_title', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const put = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ history_title: 12345 });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/history_title/);
  });

  it('PUT /api/profile with whitespace-only history_title clears to empty (= default UX)', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ history_title: '🌙 月亮的家' })
      .expect(200);

    const put = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ history_title: '     ' });
    expect(put.status).toBe(200);
    expect(put.body.history_title).toBe('');

    const status = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(status.body.history_title).toBe('');
  });

  it('history_title is per-user — partner does NOT see my custom title', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const bob = await registerUser(app, 'Bob');
    await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_id: bob.user_id })
      .expect(200);

    // Alice picks a custom title.
    await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ history_title: 'alice 的家' })
      .expect(200);

    // Bob's /status should still show empty (or whatever Bob set).
    const bobStatus = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${bob.access_token}`);
    expect(bobStatus.body.history_title).toBe('');

    // Alice's /status still shows her custom title.
    const aliceStatus = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(aliceStatus.body.history_title).toBe('alice 的家');
  });

  it('history_title survives logout / re-login (DB persistence)', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ history_title: '回家信号' })
      .expect(200);

    // Simulate logout + login (new tokens, same DB).
    const relogin = await request(app)
      .post('/api/login')
      .send({ user_id: alice.user_id, password: 'test1234' });
    expect(relogin.status).toBe(200);

    const status = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${relogin.body.access_token}`);
    expect(status.body.history_title).toBe('回家信号');
  });
});

// ────────────────────────────────────────────────────────────────────
// Client — collapseBursts (unit-style via re-implemented contract)
// ────────────────────────────────────────────────────────────────────

describe('REQ #1 — burst collapse logic (replicated for invariants)', () => {
  // Re-implement the exact contract from HistoryScreen.collapseBursts.
  // Source-pattern checks (below) verify the real file has the same
  // shape; this block asserts the BEHAVIOUR holds for the canonical
  // test cases the user described.
  type Action = { id: number; user_id: string; action_type: string; created_at: string };
  type Group = Action & { count: number; displayCreatedAt: string; latestId: number };
  const WINDOW_MS = 5 * 60 * 1000;
  function collapseBursts(actions: Action[]): Group[] {
    const out: Group[] = [];
    for (const action of actions) {
      const t = new Date(action.created_at).getTime();
      const last = out[out.length - 1];
      const lastT = last ? new Date(last.displayCreatedAt).getTime() : 0;
      if (
        last &&
        last.user_id === action.user_id &&
        last.action_type === action.action_type &&
        t - lastT <= WINDOW_MS
      ) {
        last.count += 1;
        last.displayCreatedAt = action.created_at;
        last.latestId = action.id;
      } else {
        out.push({ ...action, count: 1, displayCreatedAt: action.created_at, latestId: action.id });
      }
    }
    return out;
  }

  const t = (mins: number) => new Date(2026, 4, 22, 12, mins, 0).toISOString();

  it('same emoji, same sender, all within 5 min → one group with count=N', async () => {
    const actions = [
      { id: 1, user_id: 'A', action_type: 'kiss', created_at: t(0) },
      { id: 2, user_id: 'A', action_type: 'kiss', created_at: t(2) },
      { id: 3, user_id: 'A', action_type: 'kiss', created_at: t(4) },
      { id: 4, user_id: 'A', action_type: 'kiss', created_at: t(7) }, // 3 min after id=3 → still rolling
      { id: 5, user_id: 'A', action_type: 'kiss', created_at: t(11) }, // 4 min → still rolling
    ];
    const out = collapseBursts(actions);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(5);
    expect(out[0].id).toBe(1); // leader = first
    expect(out[0].latestId).toBe(5);
    expect(out[0].displayCreatedAt).toBe(t(11));
  });

  it('gap > 5 min splits the burst into two groups', async () => {
    const actions = [
      { id: 1, user_id: 'A', action_type: 'kiss', created_at: t(0) },
      { id: 2, user_id: 'A', action_type: 'kiss', created_at: t(2) },
      { id: 3, user_id: 'A', action_type: 'kiss', created_at: t(20) }, // 18 min after id=2
    ];
    const out = collapseBursts(actions);
    expect(out).toHaveLength(2);
    expect(out[0].count).toBe(2);
    expect(out[1].count).toBe(1);
    expect(out[1].id).toBe(3);
  });

  it('different emoji breaks the burst', async () => {
    const actions = [
      { id: 1, user_id: 'A', action_type: 'kiss', created_at: t(0) },
      { id: 2, user_id: 'A', action_type: 'kiss', created_at: t(1) },
      { id: 3, user_id: 'A', action_type: 'hug',  created_at: t(2) },
      { id: 4, user_id: 'A', action_type: 'kiss', created_at: t(3) },
    ];
    const out = collapseBursts(actions);
    expect(out).toHaveLength(3);
    expect(out.map(g => `${g.action_type}×${g.count}`)).toEqual(['kiss×2', 'hug×1', 'kiss×1']);
  });

  it('different sender breaks the burst even on same emoji', async () => {
    const actions = [
      { id: 1, user_id: 'A', action_type: 'kiss', created_at: t(0) },
      { id: 2, user_id: 'B', action_type: 'kiss', created_at: t(1) }, // partner
      { id: 3, user_id: 'A', action_type: 'kiss', created_at: t(2) },
    ];
    const out = collapseBursts(actions);
    expect(out).toHaveLength(3);
    expect(out.every(g => g.count === 1)).toBe(true);
  });

  it('rolling window — each member just within 5 min of the previous still merges (>5 min from leader is OK)', async () => {
    const actions = [
      { id: 1, user_id: 'A', action_type: 'kiss', created_at: t(0) },
      { id: 2, user_id: 'A', action_type: 'kiss', created_at: t(4) },  // 4 min ≤ 5
      { id: 3, user_id: 'A', action_type: 'kiss', created_at: t(8) },  // 4 min from id=2 ≤ 5, even though 8 min from id=1
      { id: 4, user_id: 'A', action_type: 'kiss', created_at: t(12) }, // 4 min from id=3 ≤ 5
    ];
    const out = collapseBursts(actions);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(4);
  });

  it('singletons get count=1 (renderer hides the ×NN badge when count === 1)', async () => {
    const out = collapseBursts([
      { id: 1, user_id: 'A', action_type: 'kiss', created_at: t(0) },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// Client static checks — collapseBursts wired into HistoryScreen
// ────────────────────────────────────────────────────────────────────

describe('REQ #1 — collapseBursts wired into HistoryScreen render path', () => {
  const HIST_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'screens', 'HistoryScreen.tsx'),
    'utf8',
  );

  it('exports collapseBursts (the burst-collapse helper)', () => {
    expect(HIST_SRC).toMatch(/function\s+collapseBursts\s*\(/);
  });

  it('uses 5-minute rolling window', () => {
    expect(HIST_SRC).toMatch(/BURST_WINDOW_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  });

  it('groupByDate hands each day section into collapseBursts before returning', () => {
    // Match the call site: groupByDate maps over the day-bucketed
    // groups and runs collapseBursts on each .data array.
    expect(HIST_SRC).toMatch(/data:\s*collapseBursts\(\s*data\s*\)/);
  });

  it('renderItem passes count + displayCreatedAt-derived stamp to ActionRecord', () => {
    expect(HIST_SRC).toMatch(/count=\{\s*\(item as GroupedAction\)\.count\s*\}/);
    expect(HIST_SRC).toMatch(/displayCreatedAt\s*\?\?\s*item\.created_at/);
  });

  it('injectUnreadDivider compares against latestId for grouped items', () => {
    // The divider must surface a group BELOW it whenever any of the
    // group's members landed after the user's last-read cursor —
    // not just the leader.
    expect(HIST_SRC).toMatch(/latestId\s*\?\?\s*it\.id/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Client static checks — ActionRecord renders ×NN badge + bounce
// ────────────────────────────────────────────────────────────────────

describe('REQ #1 — ActionRecord ×NN badge + bounce animation', () => {
  const AR_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'components', 'ActionRecord.tsx'),
    'utf8',
  );

  it('accepts a count prop', () => {
    expect(AR_SRC).toMatch(/count\??:\s*number/);
  });

  it('renders the ×NN badge ONLY when count > 1', () => {
    expect(AR_SRC).toMatch(/count\s*>\s*1\s*&&/);
    // JSX child interpolation: literal "×" followed by {count} expression.
    expect(AR_SRC).toMatch(/×\{count\}/);
  });

  it('triggers a spring scale pop when count strictly increments', () => {
    // The animation key: useEffect compares prev count to current,
    // animates only on positive diff. Initial mount uses prevCount =
    // count so a "kiss ×3" loaded from history does NOT bounce.
    expect(AR_SRC).toMatch(/prevCountRef/);
    expect(AR_SRC).toMatch(/count\s*>\s*prevCountRef\.current/);
    expect(AR_SRC).toMatch(/Animated\.sequence\(/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Client static checks — HistoryScreen title long-press
// ────────────────────────────────────────────────────────────────────

describe('REQ #2 — HistoryScreen header title is long-pressable + persists', () => {
  const HIST_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'screens', 'HistoryScreen.tsx'),
    'utf8',
  );

  it('header Text has onLongPress wired to promptEditHistoryTitle', () => {
    // The header Text in render must accept onLongPress; the handler
    // sits above (Alert.prompt) and updates state + persists.
    expect(HIST_SRC).toMatch(/onLongPress=\{promptEditHistoryTitle\}/);
  });

  it('falls back to DEFAULT_HISTORY_TITLE when historyTitle is empty/whitespace', () => {
    expect(HIST_SRC).toMatch(/DEFAULT_HISTORY_TITLE\s*=\s*'香宝聚集地 💕'/);
    expect(HIST_SRC).toMatch(/historyTitle\.trim\(\)\)\s*\|\|\s*DEFAULT_HISTORY_TITLE/);
  });

  it('promptEditHistoryTitle persists via api.updateProfile + storage.setHistoryTitle', () => {
    const idx = HIST_SRC.indexOf('promptEditHistoryTitle');
    expect(idx).toBeGreaterThanOrEqual(0);
    const slice = HIST_SRC.slice(idx, idx + 1500);
    expect(slice).toMatch(/api\.updateProfile\(/);
    expect(slice).toMatch(/storage\.setHistoryTitle\(/);
    expect(slice).toMatch(/Alert\.prompt\(/);
  });

  it('App.tsx bootstrap caches history_title into AsyncStorage so first focus already has it', () => {
    const APP_SRC = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'App.tsx'),
      'utf8',
    );
    expect(APP_SRC).toMatch(/storage\.setHistoryTitle\(status\.history_title\)/);
  });

  it('storage util exposes get/setHistoryTitle inside the per-account KEYS set', () => {
    const STO_SRC = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'utils', 'storage.ts'),
      'utf8',
    );
    expect(STO_SRC).toMatch(/HISTORY_TITLE:\s*'couple_buzz_history_title'/);
    expect(STO_SRC).toMatch(/getHistoryTitle\(\)/);
    expect(STO_SRC).toMatch(/setHistoryTitle\(/);
  });
});
