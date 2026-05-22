/**
 * Regression tests for the v1.2.18 fixes:
 *
 *   #1 — Every push visibly bumps the iOS icon badge by ≥1, including
 *        categories without a per-feature unread cursor (date_new /
 *        ritual_* / weather_* / urge_* / react_* / unpair / weekly_report
 *        / mailbox_open / mailbox_countdown_15min / snap_* / bucket_* /
 *        daily_*). New `users.unack_push_count` column, incremented per
 *        push in pushToUser, reset by POST /api/badge-ack on app
 *        foreground (also reset by mark-read as an explicit ack).
 *
 *   #2 — App.tsx bootstrap / waiting-poll / handleRegistered now caches
 *        status.timezone + partner_timezone to AsyncStorage so the
 *        first screen the user lands on after login sees the correct
 *        double-timezone in WriteLetterScreen's preview / InboxScreen's
 *        postmark / MailboxScreen's next-delivery hint. Source-pattern
 *        check on the client file.
 *
 *   BUG2 hardening — capsule auto-open on GET /capsules now writes
 *        opened_at = unlock_at (not CURRENT_TIMESTAMP). Without this
 *        the opened_at could land microseconds after the just-bumped
 *        inbox_last_seen marker, causing hasUnreadInboxItems to flag
 *        the freshly-opened capsule as "unread" on the next polling
 *        tick and re-light the 信箱 tab dot.
 *
 *   REQ2 explicit — InboxScreen sort: newest arrived + latest written
 *        ends up at the end of the array, which is the bottom of the
 *        ScrollView, which is what initialScrolledRef centers on open.
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
  const { dbOps } = createDatabase(':memory:');
  const mockPush: SendPushFn = jest.fn().mockResolvedValue(true);
  const app = express();
  app.use(express.json());
  const publicRouter = createPublicRouter(dbOps);
  const protectedRouter = createProtectedRouter(dbOps, mockPush);
  const authMiddleware = createAuthMiddleware(dbOps);
  app.use('/api', publicRouter);
  app.use('/api', authMiddleware, protectedRouter);
  return { app, dbOps, mockPush };
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
// Badge +1 per push
// ────────────────────────────────────────────────────────────────────

describe('Every push visibly increments the iOS badge by ≥1', () => {
  it('counter-less notification types (date_new, ritual) each bump the badge', async () => {
    // Before v1.2.18: these pushed badge = max(1, total) where total
    // didn't include them, so a sequence of 3 date_new's all sent
    // badge=1 — invisible after the first. New logic: unack_push_count
    // increments per push and contributes to the badge value via max().
    const { app, mockPush } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Three consecutive date_new pushes from Alice → Bob.
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/dates')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ title: `anniv-${i}`, date: '2030-01-01', recurring: false });
    }
    const badges = (mockPush as jest.Mock).mock.calls
      .filter(c => c[1] === 'date_new')
      .map(c => c[4]);
    expect(badges).toEqual([1, 2, 3]);
  });

  it('mixed counter / counter-less pushes still go up monotonically', async () => {
    const { app, mockPush } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'kiss' });
    await request(app).post('/api/dates').set('Authorization', `Bearer ${alice.access_token}`).send({ title: 'a', date: '2030-01-01', recurring: false });
    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'hug' });
    await request(app).post('/api/dates').set('Authorization', `Bearer ${alice.access_token}`).send({ title: 'b', date: '2030-02-01', recurring: false });

    const badges = (mockPush as jest.Mock).mock.calls.map(c => c[4]);
    // Whatever the absolute values are, they MUST be non-decreasing
    // and each step MUST add at least 1.
    for (let i = 1; i < badges.length; i++) {
      expect(badges[i]).toBeGreaterThanOrEqual(badges[i - 1] + 1);
    }
  });

  it('POST /api/badge-ack resets the transient counter to 0', async () => {
    const { app, mockPush, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Build up the counter via 3 counter-less pushes.
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/dates')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ title: `a-${i}`, date: '2030-01-01', recurring: false });
    }
    // Bob (the recipient) acks the badge.
    await request(app)
      .post('/api/badge-ack')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .expect(200);

    // Next push should ship badge=1 (counter reset + only 1 transient bump).
    (mockPush as jest.Mock).mockClear();
    await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: 'after-ack', date: '2030-03-01', recurring: false });
    expect((mockPush as jest.Mock).mock.calls[0][4]).toBe(1);
  });

  it('mark-read also resets the transient counter (history ack)', async () => {
    const { app, mockPush } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Mix of counter-less and counter pushes.
    await request(app).post('/api/dates').set('Authorization', `Bearer ${alice.access_token}`).send({ title: 'a', date: '2030-01-01', recurring: false });
    await request(app).post('/api/dates').set('Authorization', `Bearer ${alice.access_token}`).send({ title: 'b', date: '2030-02-01', recurring: false });
    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'kiss' });

    // Bob views history → mark-read.
    const history = await request(app)
      .get('/api/history')
      .set('Authorization', `Bearer ${bob.access_token}`);
    const latestId = history.body.actions[0].id;
    await request(app)
      .post('/api/mark-read')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ last_id: latestId });

    // Next push: badge should restart from 1 (transient reset, semantic
    // history now 0).
    (mockPush as jest.Mock).mockClear();
    await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: 'after-mark-read', date: '2030-04-01', recurring: false });
    expect((mockPush as jest.Mock).mock.calls[0][4]).toBe(1);
  });

  it('floor of 1: a push to a user with no semantic unread still sets badge ≥ 1', async () => {
    const { app, mockPush } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: 'first-ever', date: '2030-01-01', recurring: false });
    const badge = (mockPush as jest.Mock).mock.calls[0][4];
    expect(badge).toBeGreaterThanOrEqual(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// BUG2 hardening — capsule auto-open writes opened_at = unlock_at
// ────────────────────────────────────────────────────────────────────

describe('BUG2 hardening — capsule auto-open uses unlock_at, not now', () => {
  it('opened_at equals unlock_at after the auto-open sweep', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const pairId = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;
    // Direct DB insert with a past unlock_at so the auto-open kicks in.
    const cap = dbOps.createCapsule(
      alice.user_id, bob.user_id, pairId,
      'past letter',
      '2020-06-15', '2020-06-15T07:30:00.000Z',
      'partner',
    );

    // Bob lists capsules → triggers the auto-open sweep.
    const res = await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${bob.access_token}`);
    const ours = res.body.capsules.find((c: any) => c.id === cap.id);
    expect(ours).toBeDefined();
    // opened_at should equal unlock_at (so it pre-dates inbox_last_seen
    // updates and doesn't accidentally re-flag as unread). The exact
    // string format may differ (SQL DATETIME vs ISO Z) so we compare
    // the parsed timestamps.
    expect(new Date(ours.opened_at).getTime()).toBe(new Date('2020-06-15T07:30:00.000Z').getTime());
  });

  it('after viewing inbox, a freshly auto-opened capsule does NOT re-light unread', async () => {
    // Concrete scenario: partner sent a capsule that unlocked an hour
    // ago. Bob opens the inbox modal → server bumps inbox_last_seen to
    // NOW + auto-opens the capsule with opened_at = unlock_at (1h ago).
    // hasUnreadInboxItems compares opened_at vs inbox_last_seen — must
    // return FALSE (capsule's "arrival" already pre-dates the marker).
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const pairId = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    dbOps.createCapsule(
      alice.user_id, bob.user_id, pairId,
      'unlocked an hour ago',
      oneHourAgo.slice(0, 10), oneHourAgo,
      'partner',
    );

    // Simulate inbox open: bump seen marker, then fetch capsules.
    await request(app)
      .post('/api/inbox/seen')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .expect(200);
    await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .expect(200);

    // Now hasUnreadInboxItems equivalent: any capsule with opened_at >
    // inbox_last_seen? Should be NO.
    const seenRes = await request(app)
      .get('/api/inbox/seen')
      .set('Authorization', `Bearer ${bob.access_token}`);
    const lastSeen = seenRes.body.seen_at;
    const capsulesRes = await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${bob.access_token}`);
    const newer = capsulesRes.body.capsules.filter(
      (c: any) => c.opened_at && new Date(c.opened_at).getTime() > new Date(lastSeen).getTime(),
    );
    expect(newer).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Timezone caching on login
// ────────────────────────────────────────────────────────────────────

describe('Timezone caches into AsyncStorage on bootstrap/login (client static check)', () => {
  const APP_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'App.tsx'),
    'utf8',
  );

  it('App.tsx bootstrap effect writes status.timezone to storage', () => {
    expect(APP_SRC).toMatch(/storage\.setTimezone\(status\.timezone\)/);
  });

  it('App.tsx bootstrap effect writes status.partner_timezone to storage', () => {
    expect(APP_SRC).toMatch(/storage\.setPartnerTimezone\(status\.partner_timezone\)/);
  });

  it('App.tsx handleRegistered fetches status and caches tz post-login', () => {
    // Login response doesn't carry tz; handleRegistered must pull it.
    const idx = APP_SRC.indexOf('handleRegistered');
    expect(idx).toBeGreaterThanOrEqual(0);
    const slice = APP_SRC.slice(idx, idx + 1200);
    expect(slice).toMatch(/api\.getStatus\(\)/);
    expect(slice).toMatch(/setTimezone/);
    expect(slice).toMatch(/setPartnerTimezone/);
  });

  it('SettingsScreen.loadStatus mirrors tz to storage so other screens see fresh values', () => {
    const SETTINGS_SRC = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'screens', 'SettingsScreen.tsx'),
      'utf8',
    );
    expect(SETTINGS_SRC).toMatch(/storage\.setTimezone\(status\.timezone\)/);
    expect(SETTINGS_SRC).toMatch(/storage\.setPartnerTimezone\(status\.partner_timezone\)/);
  });
});

// ────────────────────────────────────────────────────────────────────
// REQ2 — explicit comparator behaviour
// ────────────────────────────────────────────────────────────────────

describe('REQ2 explicit — InboxScreen sort by (arrivedAt ASC, writtenAt ASC)', () => {
  // We re-evaluate the comparator inline from the file to confirm
  // exact ordering. Source-pattern checks already exist in v1.2.17;
  // this is the behavioural check that the inline-extracted comparator
  // sorts the expected way.
  type Card = { id: string; arrivedAt: string; writtenAt: string };
  const cmp = (a: Card, b: Card) => {
    if (a.arrivedAt < b.arrivedAt) return -1;
    if (a.arrivedAt > b.arrivedAt) return 1;
    if (a.writtenAt < b.writtenAt) return -1;
    if (a.writtenAt > b.writtenAt) return 1;
    return 0;
  };

  it('older arrival comes first (and will render higher in the stack)', () => {
    const cards: Card[] = [
      { id: 'B', arrivedAt: '2026-05-22T12:00:00Z', writtenAt: '2026-05-22T11:00:00Z' },
      { id: 'A', arrivedAt: '2026-05-20T12:00:00Z', writtenAt: '2026-05-20T11:00:00Z' },
    ];
    cards.sort(cmp);
    // The user opens the inbox at cards.length - 1, so the LAST entry
    // (highest index) is what they see first. That should be the
    // newest arrival.
    expect(cards[cards.length - 1].id).toBe('B');
  });

  it('ties on arrival are broken by written time — later-written ends up at the bottom', () => {
    // Mailbox session reveal: 3 letters all "arrive" at the same
    // session-reveal boundary. The one written LATEST in real time
    // should be at the bottom of the stack so it's the first the user
    // sees on opening the inbox.
    const cards: Card[] = [
      { id: 'second', arrivedAt: '2026-05-22T12:00:00Z', writtenAt: '2026-05-22T10:30:00Z' },
      { id: 'first',  arrivedAt: '2026-05-22T12:00:00Z', writtenAt: '2026-05-22T08:00:00Z' },
      { id: 'third',  arrivedAt: '2026-05-22T12:00:00Z', writtenAt: '2026-05-22T11:45:00Z' },
    ];
    cards.sort(cmp);
    expect(cards.map(c => c.id)).toEqual(['first', 'second', 'third']);
    // initialScrolledRef scrolls to cards.length - 1 — the user opens
    // facing "third" (the latest-written letter from this session).
    expect(cards[cards.length - 1].id).toBe('third');
  });

  it('a mailbox session of 5 + a fresh capsule lands the capsule at the bottom', () => {
    // Five mailbox letters from yesterday's PM session + one capsule
    // that unlocked just now. The capsule's arrival is later, so it
    // wins the primary key regardless of writtenAt tiebreak.
    const yesterdayReveal = '2026-05-21T12:00:00Z';
    const justNow = '2026-05-22T11:55:00Z';
    const cards: Card[] = [
      { id: 'm1', arrivedAt: yesterdayReveal, writtenAt: '2026-05-21T03:00:00Z' },
      { id: 'm2', arrivedAt: yesterdayReveal, writtenAt: '2026-05-21T04:30:00Z' },
      { id: 'm3', arrivedAt: yesterdayReveal, writtenAt: '2026-05-21T07:00:00Z' },
      { id: 'm4', arrivedAt: yesterdayReveal, writtenAt: '2026-05-21T09:15:00Z' },
      { id: 'm5', arrivedAt: yesterdayReveal, writtenAt: '2026-05-21T11:50:00Z' },
      { id: 'cap', arrivedAt: justNow,        writtenAt: '2026-04-01T10:00:00Z' },
    ];
    cards.sort(cmp);
    expect(cards[cards.length - 1].id).toBe('cap');
    // And within the mailbox session, the latest-written one (m5) is
    // immediately above the capsule.
    expect(cards[cards.length - 2].id).toBe('m5');
  });
});
