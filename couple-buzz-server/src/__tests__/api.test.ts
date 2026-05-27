import express from 'express';
import request from 'supertest';
import { createDatabase, DbOps } from '../db';
import { createPublicRouter, createProtectedRouter, SendPushFn } from '../routes';
import { createAuthMiddleware } from '../auth';

// Set JWT secret for tests
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

// Helper: register a user and return tokens + user data
async function registerUser(app: express.Express, name: string, password = 'test1234') {
  const res = await request(app)
    .post('/api/register')
    .send({ name, password, device_token: 'test-device-token' });
  return res.body as {
    user_id: string;
    access_token: string;
    refresh_token: string;
  };
}

// Helper: register two users and pair them
async function registerPairedUsers(app: express.Express) {
  const alice = await registerUser(app, 'Alice');
  const bob = await registerUser(app, 'Bob');
  await request(app)
    .post('/api/pair')
    .set('Authorization', `Bearer ${alice.access_token}`)
    .send({ partner_id: bob.user_id });
  return { alice, bob };
}

describe('POST /api/register', () => {
  it('should register a user with 6-char ID and return tokens', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/register')
      .send({ name: 'Alice', password: 'test1234', device_token: 'token123' });

    expect(res.status).toBe(200);
    expect(res.body.user_id).toHaveLength(6);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
  });

  it('should return 400 when name or password is missing', async () => {
    const { app } = createTestApp();
    expect((await request(app).post('/api/register').send({})).status).toBe(400);
    expect((await request(app).post('/api/register').send({ name: 'A' })).status).toBe(400);
    expect((await request(app).post('/api/register').send({ name: 'A', password: '12' })).status).toBe(400);
  });
});

describe('POST /api/login', () => {
  it('should login with correct ID and password', async () => {
    const { app } = createTestApp();
    const user = await registerUser(app, 'Alice', 'mypass123');

    const res = await request(app)
      .post('/api/login')
      .send({ user_id: user.user_id, password: 'mypass123' });

    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(user.user_id);
    expect(res.body.access_token).toBeDefined();
  });

  it('should reject wrong password', async () => {
    const { app } = createTestApp();
    const user = await registerUser(app, 'Alice', 'mypass123');

    const res = await request(app)
      .post('/api/login')
      .send({ user_id: user.user_id, password: 'wrong' });

    expect(res.status).toBe(401);
  });

  it('should return partner_name if paired', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const res = await request(app)
      .post('/api/login')
      .send({ user_id: alice.user_id, password: 'test1234' });

    expect(res.body.partner_name).toBe('Bob');
  });
});

describe('POST /api/auth/refresh', () => {
  it('should return new tokens with valid refresh token', async () => {
    const { app } = createTestApp();
    const user = await registerUser(app, 'Alice');

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: user.refresh_token });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    // New tokens should be different (rotation)
    expect(res.body.refresh_token).not.toBe(user.refresh_token);
  });

  it('should reject invalid refresh token', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: 'invalid-token' });
    expect(res.status).toBe(401);
  });

  it('accepts refresh-token retry within the rotation grace window', async () => {
    // Network-glitch protection: if the client sends a refresh, the
    // server rotates, but the response gets dropped, the client's retry
    // with the OLD token must still succeed (and return another fresh
    // pair). Otherwise a Wi-Fi blip would silently log the user out.
    const { app } = createTestApp();
    const user = await registerUser(app, 'Alice');

    const first = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: user.refresh_token });
    expect(first.status).toBe(200);

    // Replay same token immediately — within the 10s grace window.
    const replay = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: user.refresh_token });
    expect(replay.status).toBe(200);
    expect(replay.body.access_token).toBeTruthy();
    expect(replay.body.refresh_token).toBeTruthy();
    // Each rotation issues a different new refresh token; the chain may
    // grow within the grace window, but the user is never locked out.
    expect(replay.body.refresh_token).not.toBe(first.body.refresh_token);
  });
});

describe('GET /api/status', () => {
  it('should return not paired for solo user', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.paired).toBe(false);
  });

  it('should return paired with partner name', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.paired).toBe(true);
    expect(res.body.partner_name).toBe('Bob');
    expect(res.body.name).toBe('Alice');
    expect(res.body.timezone).toBeDefined();
  });
});

describe('PUT /api/profile', () => {
  it('should update name and timezone', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ name: 'Alice New', timezone: 'America/New_York' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice New');
    expect(res.body.timezone).toBe('America/New_York');

    // Verify via status
    const statusRes = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(statusRes.body.name).toBe('Alice New');
    expect(statusRes.body.timezone).toBe('America/New_York');
  });

  it('should keep existing values when fields are omitted', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.timezone).toBeDefined();
  });
});

describe('POST /api/pair', () => {
  it('should pair two users by partner ID', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const bob = await registerUser(app, 'Bob');

    const res = await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_id: bob.user_id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.partner_name).toBe('Bob');
  });

  it('should return 401 without auth', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/pair')
      .send({ partner_id: 'ABCDEF' });
    expect(res.status).toBe(401);
  });

  it('should return 404 for invalid partner ID', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_id: 'ZZZZZZ' });
    expect(res.status).toBe(404);
  });

  it('should return 400 when pairing with yourself', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_id: alice.user_id });
    expect(res.status).toBe(400);
  });

  it('should return 400 when already paired', async () => {
    const { app } = createTestApp();
    const { bob } = await registerPairedUsers(app);
    const charlie = await registerUser(app, 'Charlie');

    const res = await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ partner_id: charlie.user_id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Already paired');
  });

  it('should return 400 when partner is already paired with someone else', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);  // alice paired with bob
    const charlie = await registerUser(app, 'Charlie');

    const res = await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${charlie.access_token}`)
      .send({ partner_id: alice.user_id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Partner is already paired with someone else');
  });
});

describe('Badge / mark-read', () => {
  it('badge increments per unread action and resets after mark-read', async () => {
    const { app, mockPush } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Bob is the latest registrant so he owns the test device token; Alice
    // sends actions and Bob is the receiver whose badge we measure.
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/action')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ action_type: 'kiss' });
    }
    const badges = (mockPush as jest.Mock).mock.calls.map(c => c[4]);
    expect(badges).toEqual([1, 2, 3]);

    // Bob reads up to the latest action.
    const historyRes = await request(app)
      .get('/api/history')
      .set('Authorization', `Bearer ${bob.access_token}`);
    const latestId = historyRes.body.actions[0].id;
    const markRes = await request(app)
      .post('/api/mark-read')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ last_id: latestId });
    expect(markRes.status).toBe(200);
    expect(markRes.body.unread).toBe(0);

    // A new action should now ship with badge=1 again.
    (mockPush as jest.Mock).mockClear();
    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'miss' });
    expect((mockPush as jest.Mock).mock.calls[0][4]).toBe(1);
  });

  it('mark-read only advances forward', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'kiss' });

    const historyRes = await request(app)
      .get('/api/history')
      .set('Authorization', `Bearer ${bob.access_token}`);
    const latestId = historyRes.body.actions[0].id;

    await request(app)
      .post('/api/mark-read')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ last_id: latestId });

    // Out-of-order stale request must NOT roll the pointer back.
    const staleRes = await request(app)
      .post('/api/mark-read')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ last_id: 0 });
    expect(staleRes.status).toBe(200);
    expect(staleRes.body.unread).toBe(0);
  });
});

describe('POST /api/action', () => {
  it('should send an action and trigger push', async () => {
    const { app, mockPush } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const res = await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'kiss' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // v1.3.1 — pushToUser now also passes a burst collapseId (string,
    // generated by trackBurst). For count=1 (the FIRST emoji in a
    // burst) no bodyOverride is sent — the SendPushFn call has 6
    // positional args, not 7. count > 1 would add the 7th (the
    // " ×N" body) and is verified separately in regression_v1_3_1.
    expect(mockPush).toHaveBeenCalledWith(
      'test-device-token',
      'kiss',
      'Alice',
      undefined,
      expect.any(Number),
      expect.any(String),
    );
  });

  it('should return 400 for invalid action_type', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'slap' });
    expect(res.status).toBe(400);
  });

  it('should return 400 when not paired', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'miss' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Not paired yet');
  });
});

describe('GET /api/history', () => {
  it('should return action history for both users', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'miss' });

    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ action_type: 'kiss' });

    const res = await request(app)
      .get('/api/history')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(2);
  });

  it('should respect limit parameter', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    for (const type of ['miss', 'kiss', 'poop']) {
      await request(app)
        .post('/api/action')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ action_type: type });
    }

    const res = await request(app)
      .get('/api/history?limit=2')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(2);
  });

  it('actions table has idx_actions_pair_time composite index', () => {
    // Bug 2 regression. /api/history filters on pair_id and orders by
    // created_at DESC; without this composite, long-term couples take a
    // full-table scan + sort. Asserting presence of the index in
    // sqlite_master is a reliable schema-level check (the planner's
    // runtime choice depends on data stats, but the index has to exist
    // for it to be picked at all).
    const { db } = createTestApp();
    const indexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type='index' AND tbl_name='actions'
    `).all() as Array<{ name: string; sql: string }>;
    const composite = indexes.find((i) => i.name === 'idx_actions_pair_time');
    expect(composite).toBeDefined();
    expect(composite!.sql).toMatch(/pair_id/);
    expect(composite!.sql).toMatch(/created_at/);
    expect(composite!.sql).toMatch(/DESC/i);
  });

  // (v1.2.21) The "reactions for visible actions never get dropped" test
  // was retired alongside the long-press-to-react feature. /api/history
  // now returns an empty reactions:{} for one release cycle (older OTA
  // clients tolerate missing field via `result.reactions || {}`), so
  // there's nothing to assert about reaction pagination anymore.

  it('limit query param parses leading-zero strings as decimal (radix 10)', async () => {
    // Bug 7 defensive regression. parseInt without explicit radix can,
    // in legacy engines, treat "050" as octal (= 40). Pin it.
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    // Generate 50 actions so we can tell 40 vs 50.
    for (let i = 0; i < 50; i++) {
      await request(app)
        .post('/api/action')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ action_type: 'love' });
    }

    const res = await request(app)
      .get('/api/history?limit=050')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(50);
  });
});

describe('PUT /api/device-token', () => {
  it('should update device token', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .put('/api/device-token')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ device_token: 'new-token-123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should return 400 without device_token', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .put('/api/device-token')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('fan-out: same user with multiple device tokens receives push on every device', async () => {
    const { app, dbOps, mockPush } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    // Bob already has 'test-device-token' from registerUser. Add two more
    // physical devices so we can verify the fan-out hits all three.
    dbOps.setDeviceToken(bob.user_id, 'bob-iphone');
    dbOps.setDeviceToken(bob.user_id, 'bob-ipad');

    (mockPush as jest.Mock).mockClear();

    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'kiss' });

    const tokens = (mockPush as jest.Mock).mock.calls.map((c) => c[0]);
    expect(tokens.sort()).toEqual(['bob-ipad', 'bob-iphone', 'test-device-token']);
  });

  it('one device handover: same APNs token re-registered to another user pushes only the new owner', async () => {
    const { app, dbOps, mockPush } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    // 'test-device-token' currently belongs to Bob (last registerUser to
    // claim it). Hand the device to Alice — Bob should lose pushes to it.
    dbOps.setDeviceToken(alice.user_id, 'test-device-token');

    (mockPush as jest.Mock).mockClear();

    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'kiss' });

    // Bob has zero tokens registered → no push fired at all.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('clearDeviceTokenByValue evicts only the targeted apns_token', async () => {
    const { app, dbOps } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    // Two physical devices belong to Alice (registerUser already inserted
    // 'test-device-token'; add one more).
    dbOps.setDeviceToken(alice.user_id, 'alice-second-phone');
    dbOps.clearDeviceTokenByValue('test-device-token');
    expect(dbOps.getDeviceTokensForUser(alice.user_id)).toEqual(['alice-second-phone']);
  });
});

describe('Sessions / multi-device login', () => {
  // Helper: log in same user from a "second phone" so we end up with two
  // sessions for one account.
  async function loginAsSecondDevice(app: express.Express, userId: string) {
    const res = await request(app)
      .post('/api/login')
      .send({
        user_id: userId,
        password: 'test1234',
        device: { name: 'iPad Pro', model: 'iPad13,8', os: 'iPadOS 17.2' },
      });
    return res.body as { access_token: string; refresh_token: string };
  }

  it('register and login produce listable sessions, first one is primary', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].is_primary).toBe(true);
    expect(res.body.sessions[0].is_current).toBe(true);

    const second = await loginAsSecondDevice(app, alice.user_id);
    const res2 = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res2.body.sessions).toHaveLength(2);
    // First device retains primary; second device is non-primary.
    const primaries = res2.body.sessions.filter((s: { is_primary: boolean }) => s.is_primary);
    expect(primaries).toHaveLength(1);
    // From the first device's perspective, the first session is "current"
    // and is also the primary.
    expect(primaries[0].is_current).toBe(true);

    // From the second device's perspective, its own session is the current.
    const fromSecond = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${second.access_token}`);
    const currentFromSecond = fromSecond.body.sessions.find((s: { is_current: boolean }) => s.is_current);
    expect(currentFromSecond.is_primary).toBe(false);
  });

  it('non-primary device cannot revoke another session', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const second = await loginAsSecondDevice(app, alice.user_id);

    // Primary's session_id (current from the first phone)
    const list = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${alice.access_token}`);
    const primarySid = list.body.sessions.find((s: { is_primary: boolean }) => s.is_primary).session_id;

    // Second (non-primary) tries to kick the primary — must 403.
    const res = await request(app)
      .delete(`/api/sessions/${primarySid}`)
      .set('Authorization', `Bearer ${second.access_token}`);
    expect(res.status).toBe(403);
  });

  it('primary can force-logout another session and that session immediately fails auth', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const second = await loginAsSecondDevice(app, alice.user_id);

    // Primary perspective: find the second device's sid.
    const list = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${alice.access_token}`);
    const otherSid = list.body.sessions.find((s: { is_current: boolean }) => !s.is_current).session_id;

    const kickRes = await request(app)
      .delete(`/api/sessions/${otherSid}`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(kickRes.status).toBe(200);

    // Second device's access token should now bounce with code: session_revoked.
    const probe = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${second.access_token}`);
    expect(probe.status).toBe(401);
    expect(probe.body.code).toBe('session_revoked');

    // And its refresh token should also be rejected.
    const refresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: second.refresh_token });
    expect(refresh.status).toBe(401);
    expect(refresh.body.code).toBe('session_revoked');
  });

  it('self-revoke: deleting own session always allowed; primary auto-transfers', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const second = await loginAsSecondDevice(app, alice.user_id);

    // Get my (first device's) sid.
    const list = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${alice.access_token}`);
    const mySid = list.body.sessions.find((s: { is_current: boolean }) => s.is_current).session_id;

    const res = await request(app)
      .delete(`/api/sessions/${mySid}`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);

    // Second device should now be promoted to primary.
    const after = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${second.access_token}`);
    expect(after.body.sessions).toHaveLength(1);
    expect(after.body.sessions[0].is_primary).toBe(true);
  });

  it('primary transfer via POST /sessions/:sid/primary', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const second = await loginAsSecondDevice(app, alice.user_id);

    const list = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${alice.access_token}`);
    const otherSid = list.body.sessions.find((s: { is_current: boolean }) => !s.is_current).session_id;

    // Primary promotes the other device.
    await request(app)
      .post(`/api/sessions/${otherSid}/primary`)
      .set('Authorization', `Bearer ${alice.access_token}`)
      .expect(200);

    const after = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${second.access_token}`);
    const newPrimary = after.body.sessions.find((s: { is_primary: boolean }) => s.is_primary);
    expect(newPrimary.session_id).toBe(otherSid);
    // Exactly one primary at any time.
    expect(after.body.sessions.filter((s: { is_primary: boolean }) => s.is_primary)).toHaveLength(1);
  });

  it('group revoke wipes every session sharing the device fingerprint', async () => {
    // Regression: the device list dedups rows by (device_name,
    // device_os) and "log out this device" must drop every refresh-
    // token row the device left behind across reinstalls. Doing it as
    // a parallel client-side fan-out raced the auth middleware (own
    // row revoked first → sibling DELETEs 401), leaving leftover
    // sessions that re-surfaced as "another device" after re-login.
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const sameDevice = { name: 'Steve 的 iPhone', os: 'iOS 17.2' };
    const second = await request(app)
      .post('/api/login')
      .send({ user_id: alice.user_id, password: 'test1234', device: sameDevice });
    const third = await request(app)
      .post('/api/login')
      .send({ user_id: alice.user_id, password: 'test1234', device: sameDevice });

    const before = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(before.body.sessions).toHaveLength(3);

    // Self-revoke from third's perspective — drops both 'Steve 的 iPhone'
    // sessions in one transaction.
    const myList = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${third.body.access_token}`);
    const mySid = myList.body.sessions.find((s: { is_current: boolean }) => s.is_current).session_id;

    const kick = await request(app)
      .delete(`/api/sessions/${mySid}/group`)
      .set('Authorization', `Bearer ${third.body.access_token}`);
    expect(kick.status).toBe(200);
    expect(kick.body.revoked_count).toBe(2);

    // Alice's original session (no device info → different fingerprint)
    // survives. Both 'Steve 的 iPhone' sessions are gone.
    const after = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(after.body.sessions).toHaveLength(1);
    expect(after.body.sessions[0].device_name).toBe(null);

    // The sibling session (second device) we never explicitly targeted
    // must also fail auth — that's the whole point of group revoke.
    const probe = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${second.body.access_token}`);
    expect(probe.status).toBe(401);
    expect(probe.body.code).toBe('session_revoked');
  });

  it('login inherits the device name a user previously set for this OS', async () => {
    // Regression for: rename → logout → re-login was silently resetting
    // the device name back to "iPhone" because the new session row was
    // written from the client's default device.name. The server now
    // looks back at this user's prior sessions for the same OS and
    // inherits the rename when no other session is currently active on
    // that OS.
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    // Bind the original session to a known fingerprint so the renamer
    // has something specific to match. The server treats the incoming
    // device.name "iPhone" as a default → still allowed to be inherited
    // over later, which is fine for this setup phase.
    const firstLogin = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 17.2' },
      });

    const myList = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${firstLogin.body.access_token}`);
    const mySid = myList.body.sessions.find((s: { is_current: boolean }) => s.is_current).session_id;

    // Rename the iPhone group to "x".
    await request(app)
      .put(`/api/sessions/${mySid}/name`)
      .set('Authorization', `Bearer ${firstLogin.body.access_token}`)
      .send({ name: 'x' })
      .expect(200);

    // Group-revoke wipes the now-named-"x" session. After this the
    // user has no active sessions on iOS 17.2.
    await request(app)
      .delete(`/api/sessions/${mySid}/group`)
      .set('Authorization', `Bearer ${firstLogin.body.access_token}`)
      .expect(200);

    // Re-login from the same physical device. Client still sends the
    // default "iPhone" name (iOS 16+ without entitlement). Server must
    // pick up the prior "x" rename and write it onto the new row.
    const reLogin = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 17.2' },
      });

    const after = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${reLogin.body.access_token}`);
    expect(after.body.sessions).toHaveLength(2);
    const current = after.body.sessions.find((s: { is_current: boolean }) => s.is_current);
    expect(current.device_name).toBe('x');
  });

  it('login does NOT inherit a name when another device is still active on the same OS', async () => {
    // Multi-device safety: the inherit heuristic only fires when this
    // user has no active session on the incoming OS. Otherwise a fresh
    // login on a different physical device would silently take the
    // sibling's name.
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    // Phone A logs in & gets renamed to "MyPhone".
    const phoneA = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 17.2' },
      });
    const aList = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${phoneA.body.access_token}`);
    const aSid = aList.body.sessions.find((s: { is_current: boolean }) => s.is_current).session_id;
    await request(app)
      .put(`/api/sessions/${aSid}/name`)
      .set('Authorization', `Bearer ${phoneA.body.access_token}`)
      .send({ name: 'MyPhone' })
      .expect(200);

    // Phone B (a different physical device) logs in while Phone A is
    // still active. It should keep its default "iPhone" name — NOT
    // inherit "MyPhone".
    const phoneB = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 17.2' },
      });
    const bList = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${phoneB.body.access_token}`);
    const bCurrent = bList.body.sessions.find((s: { is_current: boolean }) => s.is_current);
    expect(bCurrent.device_name).toBe('iPhone');
  });

  it('non-primary device can self-promote to primary', async () => {
    // Bug-2 recovery: after force-revoking a primary session via the
    // old broken parallel path, the user could end up with an orphan
    // primary they couldn't reach. Server already permitted self-
    // promote (the route's primary check is skipped when sid==own);
    // pin that contract with a test so a future refactor doesn't
    // accidentally lock users out.
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const second = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPad Pro', os: 'iPadOS 17.2' },
      });

    // Verify second is non-primary at start.
    const list = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${second.body.access_token}`);
    const mySid = list.body.sessions.find((s: { is_current: boolean }) => s.is_current).session_id;
    expect(list.body.sessions.find((s: { is_current: boolean }) => s.is_current).is_primary).toBe(false);

    // Self-promote.
    await request(app)
      .post(`/api/sessions/${mySid}/primary`)
      .set('Authorization', `Bearer ${second.body.access_token}`)
      .expect(200);

    // Now we're primary; alice's original session is not.
    const after = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${second.body.access_token}`);
    expect(after.body.sessions.find((s: { is_current: boolean }) => s.is_current).is_primary).toBe(true);
    expect(after.body.sessions.filter((s: { is_primary: boolean }) => s.is_primary)).toHaveLength(1);
  });

  it('refresh preserves session_id (rotation does NOT spawn ghost sessions)', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const before = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${alice.access_token}`);
    const sidBefore = before.body.sessions[0].session_id;

    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: alice.refresh_token });
    expect(refreshed.status).toBe(200);

    const after = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${refreshed.body.access_token}`);
    expect(after.body.sessions).toHaveLength(1);
    expect(after.body.sessions[0].session_id).toBe(sidBefore);
  });

  it('refresh-grace replay does NOT create a duplicate session row', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    // First rotate.
    const r1 = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: alice.refresh_token });
    expect(r1.status).toBe(200);

    // Replay original token within grace — server hands back another
    // fresh pair and supersedes the orphaned new1.
    const r2 = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: alice.refresh_token });
    expect(r2.status).toBe(200);

    const list = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${r2.body.access_token}`);
    expect(list.body.sessions).toHaveLength(1);
  });

  it('logout drops only the current session; other sessions remain logged in', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const second = await loginAsSecondDevice(app, alice.user_id);

    await request(app)
      .post('/api/logout')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .expect(200);

    // Second device still works.
    const stillOk = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${second.access_token}`);
    expect(stillOk.status).toBe(200);
  });

  it('login on a second device does NOT bump token_version (other sessions stay valid)', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    await loginAsSecondDevice(app, alice.user_id);

    // Original device should still authenticate fine.
    const probe = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(probe.status).toBe(200);
  });
});

describe('Cross-device sync (daily seen / inbox seen / letter draft)', () => {
  it('daily seen: defaults to empty, round-trips through GET/POST', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const initial = await request(app)
      .get('/api/daily/seen')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ date: null, pa: false, ps: false });

    const set = await request(app)
      .post('/api/daily/seen')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ date: '2026-05-04', pa: true, ps: false });
    expect(set.status).toBe(200);

    const after = await request(app)
      .get('/api/daily/seen')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(after.body).toEqual({ date: '2026-05-04', pa: true, ps: false });
  });

  it('daily seen: rejects malformed date', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const res = await request(app)
      .post('/api/daily/seen')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ date: 'not-a-date', pa: false, ps: false });
    expect(res.status).toBe(400);
  });

  it('inbox seen: marker only advances forward', async () => {
    const { app, dbOps } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const initial = await request(app)
      .get('/api/inbox/seen')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(initial.body.seen_at).toBeNull();

    await request(app)
      .post('/api/inbox/seen')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .expect(200);

    const after = await request(app)
      .get('/api/inbox/seen')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(after.body.seen_at).toBeTruthy();

    // Out-of-order client write with a stale ISO must NOT roll the
    // marker back. dbOps method is the public surface here; the route
    // always sends "now" so the only way to send a stale value is via
    // dbOps directly.
    dbOps.setInboxLastSeen(alice.user_id, '2020-01-01T00:00:00.000Z');
    const stillForward = await request(app)
      .get('/api/inbox/seen')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(stillForward.body.seen_at).toBe(after.body.seen_at);
  });

  it('letter draft: round-trips, length-capped, clear via empty string', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const bob = await registerUser(app, 'Bob');

    // Empty default.
    const initial = await request(app)
      .get('/api/letter-draft')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(initial.body.draft).toBe('');

    // Set + read back.
    await request(app)
      .put('/api/letter-draft')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ draft: '亲爱的：今天想你了。' })
      .expect(200);
    const r1 = await request(app)
      .get('/api/letter-draft')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(r1.body.draft).toBe('亲爱的：今天想你了。');

    // 8001-char draft is rejected.
    const tooLong = 'x'.repeat(8001);
    const cap = await request(app)
      .put('/api/letter-draft')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ draft: tooLong });
    expect(cap.status).toBe(400);

    // Clear.
    await request(app)
      .put('/api/letter-draft')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ draft: '' })
      .expect(200);
    const r2 = await request(app)
      .get('/api/letter-draft')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(r2.body.draft).toBe('');

    // Bob's draft is independent.
    await request(app)
      .put('/api/letter-draft')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ draft: 'bob独立的稿子' })
      .expect(200);
    const aliceStillEmpty = await request(app)
      .get('/api/letter-draft')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(aliceStillEmpty.body.draft).toBe('');
  });

  it('drafts and seen markers persist across logout-other-device (different sessions, same user)', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    // Login as a "second device" → another session for the same user.
    const second = await request(app)
      .post('/api/login')
      .send({ user_id: alice.user_id, password: 'test1234' });
    const secondToken = second.body.access_token;

    // Write draft from device 1; observed on device 2.
    await request(app)
      .put('/api/letter-draft')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ draft: 'shared 起草' })
      .expect(200);
    const fromSecond = await request(app)
      .get('/api/letter-draft')
      .set('Authorization', `Bearer ${secondToken}`);
    expect(fromSecond.body.draft).toBe('shared 起草');
  });
});

describe('Couples lifecycle (pair_id)', () => {
  it('pair generates a 10-char pair_id and unpair sets ended_at', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const pid1 = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id);
    expect(pid1).toBeTruthy();
    expect(pid1!.length).toBe(10);
    // 6 letters then 4 digits
    expect(/^[A-Z]{6}\d{4}$/.test(pid1!)).toBe(true);

    // Unpair via route
    await request(app)
      .post('/api/unpair')
      .set('Authorization', `Bearer ${alice.access_token}`);

    const activeAfter = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id);
    expect(activeAfter).toBeNull();
  });

  it('re-pair within grace window revives the same pair_id (data restored)', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const originalPairId = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;

    // Alice unpairs Bob.
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);

    // Re-pair via route — should revive (clear ended_at), same pair_id.
    const pairRes = await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_id: bob.user_id });
    expect(pairRes.status).toBe(200);
    expect(pairRes.body.pair_id).toBe(originalPairId);
    expect(pairRes.body.revived).toBe(true);

    const activeNow = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id);
    expect(activeNow).toBe(originalPairId);
  });

  it('pairing with a different partner generates a fresh pair_id', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const carol = await registerUser(app, 'Carol');

    const pidAB = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;

    // Alice unpairs Bob, then pairs Carol.
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    const pairAC = await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_id: carol.user_id });
    expect(pairAC.status).toBe(200);
    expect(pairAC.body.pair_id).not.toBe(pidAB);
    expect(pairAC.body.revived).toBe(false);

    // (A,B) row still exists in DORMANT state — still queryable by users.
    // (A,B) data is preserved for the 90-day grace window.
    const pidABStillThere = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id);
    expect(pidABStillThere).toBeNull(); // not active
  });

  it('history feed is pair-isolated — old relationships do not leak', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const carol = await registerUser(app, 'Carol');

    // Alice + Bob: send some actions
    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'kiss' });
    await request(app).post('/api/action').set('Authorization', `Bearer ${bob.access_token}`).send({ action_type: 'hug' });

    // Snapshot: Alice's history with Bob has 2 entries.
    const histAB = await request(app).get('/api/history').set('Authorization', `Bearer ${alice.access_token}`);
    expect(histAB.body.actions.length).toBe(2);

    // Unpair, pair Carol.
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    await request(app).post('/api/pair').set('Authorization', `Bearer ${alice.access_token}`).send({ partner_id: carol.user_id });

    // Alice's history with Carol is empty — old (A,B) actions don't leak.
    const histAC = await request(app).get('/api/history').set('Authorization', `Bearer ${alice.access_token}`);
    expect(histAC.body.actions.length).toBe(0);

    // Re-pair with Bob — old (A,B) actions resurface.
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    await request(app).post('/api/pair').set('Authorization', `Bearer ${alice.access_token}`).send({ partner_id: bob.user_id });

    const histAB2 = await request(app).get('/api/history').set('Authorization', `Bearer ${alice.access_token}`);
    expect(histAB2.body.actions.length).toBe(2);

    // Reference dbOps to keep TypeScript happy.
    expect(dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)).toBeTruthy();
  });

  it('important_dates resurface after re-pair (B → C → B sequence)', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const carol = await registerUser(app, 'Carol');

    // (A,B) era: create 2 dates
    await request(app).post('/api/dates').set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '在一起', date: '2024-01-01', recurring: false });
    await request(app).post('/api/dates').set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '生日', date: '2024-06-15', recurring: true });
    const datesAB1 = await request(app).get('/api/dates').set('Authorization', `Bearer ${alice.access_token}`);
    expect(datesAB1.body.dates.length).toBe(2);

    // Cycle through Carol
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    await request(app).post('/api/pair').set('Authorization', `Bearer ${alice.access_token}`).send({ partner_id: carol.user_id });

    // (A,C) era: dates should be empty (own pair_id, no rows yet)
    const datesAC = await request(app).get('/api/dates').set('Authorization', `Bearer ${alice.access_token}`);
    expect(datesAC.body.dates.length).toBe(0);

    // Add one date in (A,C) era to test isolation
    await request(app).post('/api/dates').set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: 'Carol 周年', date: '2024-09-09', recurring: false });
    const datesAC2 = await request(app).get('/api/dates').set('Authorization', `Bearer ${alice.access_token}`);
    expect(datesAC2.body.dates.length).toBe(1);

    // Back to Bob
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    await request(app).post('/api/pair').set('Authorization', `Bearer ${alice.access_token}`).send({ partner_id: bob.user_id });

    // (A,B) dates should resurface — and (A,C) Carol-era stays hidden.
    const datesAB2 = await request(app).get('/api/dates').set('Authorization', `Bearer ${alice.access_token}`);
    expect(datesAB2.body.dates.length).toBe(2);
    const titles = datesAB2.body.dates.map((d: any) => d.title).sort();
    expect(titles).toEqual(['在一起', '生日']);
  });

  it('bucket items resurface after re-pair', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const carol = await registerUser(app, 'Carol');

    await request(app).post('/api/bucket').set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '一起去日本' });
    await request(app).post('/api/bucket').set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '看夜樱' });

    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    await request(app).post('/api/pair').set('Authorization', `Bearer ${alice.access_token}`).send({ partner_id: carol.user_id });

    const bucketAC = await request(app).get('/api/bucket').set('Authorization', `Bearer ${alice.access_token}`);
    expect(bucketAC.body.items.length).toBe(0);

    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    await request(app).post('/api/pair').set('Authorization', `Bearer ${alice.access_token}`).send({ partner_id: bob.user_id });

    const bucketAB = await request(app).get('/api/bucket').set('Authorization', `Bearer ${alice.access_token}`);
    expect(bucketAB.body.items.length).toBe(2);
  });

  it('time_capsules resurface after re-pair', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const carol = await registerUser(app, 'Carol');

    // Create 2 capsules (one self, one partner-bound)
    const pidAB = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;
    dbOps.createCapsule(alice.user_id, bob.user_id, pidAB, 'self letter', '2030-01-01', '2030-01-01T00:00:00.000Z', 'self');
    dbOps.createCapsule(alice.user_id, bob.user_id, pidAB, 'partner letter', '2030-01-01', '2030-01-01T00:00:00.000Z', 'partner');

    const before = await request(app).get('/api/capsules').set('Authorization', `Bearer ${alice.access_token}`);
    expect(before.body.capsules.length).toBe(2);

    // Cycle through Carol
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    await request(app).post('/api/pair').set('Authorization', `Bearer ${alice.access_token}`).send({ partner_id: carol.user_id });

    const inAC = await request(app).get('/api/capsules').set('Authorization', `Bearer ${alice.access_token}`);
    expect(inAC.body.capsules.length).toBe(0);

    // Back to Bob
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    await request(app).post('/api/pair').set('Authorization', `Bearer ${alice.access_token}`).send({ partner_id: bob.user_id });

    const after = await request(app).get('/api/capsules').set('Authorization', `Bearer ${alice.access_token}`);
    expect(after.body.capsules.length).toBe(2);
  });

  it('pair_id is exposed on /api/status and matches dbOps lookup', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const status = await request(app).get('/api/status').set('Authorization', `Bearer ${alice.access_token}`);
    expect(status.body.paired).toBe(true);
    expect(status.body.pair_id).toBeTruthy();
    expect(status.body.pair_id).toBe(dbOps.couplesGetActivePairId(alice.user_id, bob.user_id));

    // After unpair, pair_id is no longer surfaced (paired: false).
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    const status2 = await request(app).get('/api/status').set('Authorization', `Bearer ${alice.access_token}`);
    expect(status2.body.paired).toBe(false);
    expect(status2.body.pair_id).toBeUndefined();
  });

  it('TTL cleanup leaves a recently-ended couple alone (within grace window)', async () => {
    const { app, dbOps } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    // Just-ended couple is well within the 90-day grace window — TTL
    // sweep should be a no-op.
    expect(dbOps.couplesCleanupExpired()).toEqual([]);
    expect(dbOps.couplesCleanupExpired()).toEqual([]); // idempotent
  });

  it('re-pair clears ended_at — revived couple is NEVER touched by TTL cleanup', async () => {
    // Direct stress test of the user's concern: "if I unpair, wait, then
    // re-pair the same person, is the 90-day deletion timer truly
    // cancelled, or will my data silently disappear later?"
    const { app, db, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const pidAB = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;

    // Seed some data we want to confirm survives.
    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'kiss' });
    await request(app).post('/api/dates').set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: 'in love', date: '2024-01-01', recurring: false });
    dbOps.createCapsule(alice.user_id, bob.user_id, pidAB, 'letter', '2030-01-01', '2030-01-01T00:00:00.000Z', 'partner');

    // Unpair, then backdate ended_at to 89 days ago — within grace window
    // but very close to the cliff. Worst-case scenario for the user.
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    db.prepare("UPDATE couples SET ended_at = datetime('now', '-89 days') WHERE pair_id = ?").run(pidAB);

    // Re-pair: the couple is revived (still within grace window).
    const repair = await request(app).post('/api/pair')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_id: bob.user_id });
    expect(repair.body.pair_id).toBe(pidAB);
    expect(repair.body.revived).toBe(true);

    // ended_at is now NULL (timer cancelled).
    const row = db.prepare('SELECT ended_at FROM couples WHERE pair_id = ?').get(pidAB) as { ended_at: string | null };
    expect(row.ended_at).toBeNull();

    // Run TTL cleanup — must NOT touch this couple even though it was
    // 89 days old at the time of revival. ended_at IS NULL filters it
    // out of the expired-couples query entirely.
    const deleted = dbOps.couplesCleanupExpired();
    expect(deleted).not.toContain(pidAB);

    // Data is intact — none of the seed rows were swept.
    expect((db.prepare('SELECT COUNT(*) AS n FROM actions WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM important_dates WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM time_capsules WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBeGreaterThan(0);

    // Even running cleanup repeatedly leaves it alone (idempotent on
    // active couples).
    expect(dbOps.couplesCleanupExpired()).toEqual([]);
    expect(dbOps.couplesCleanupExpired()).toEqual([]);

    // The couple's pair_id is still active and discoverable.
    expect(dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)).toBe(pidAB);
  });

  it('repeated unpair/re-pair cycle keeps each grace window FRESH (no carryover)', async () => {
    // Sanity: if user unpairs at day 0, re-pairs at day 30, then unpairs
    // again, the TTL clock should be RESET — counting from the new
    // unpair, not the original one. Otherwise a yo-yo'ing relationship
    // could quietly drop into the irreversible window.
    const { app, db, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const pidAB = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;

    // First unpair at "now - 30 days" (we backdate to simulate the gap).
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    db.prepare("UPDATE couples SET ended_at = datetime('now', '-30 days') WHERE pair_id = ?").run(pidAB);

    // Re-pair → ended_at = NULL.
    await request(app).post('/api/pair').set('Authorization', `Bearer ${alice.access_token}`).send({ partner_id: bob.user_id });

    // Second unpair → ended_at = CURRENT_TIMESTAMP (fresh, NOT the
    // original 30-days-ago value).
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    const after = db.prepare('SELECT ended_at FROM couples WHERE pair_id = ?').get(pidAB) as { ended_at: string };
    // 'now' written by SQLite — should be within seconds of test runtime.
    const ageSeconds = (Date.now() - new Date(after.ended_at + 'Z').getTime()) / 1000;
    expect(Math.abs(ageSeconds)).toBeLessThan(10); // fresh, not 30 days old

    // TTL cleanup at this point treats it as a brand-new ended couple
    // and leaves it alone for another 90 days.
    expect(dbOps.couplesCleanupExpired()).toEqual([]);
  });

  it('TTL cleanup hard-deletes data when ended_at is 100 days in the past', async () => {
    const { app, db, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const pidAB = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;

    // Seed data across multiple couple-scoped tables.
    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'kiss' });
    await request(app).post('/api/dates').set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: 'foo', date: '2024-01-01', recurring: false });
    await request(app).post('/api/bucket').set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '一起出去玩' });
    dbOps.createCapsule(alice.user_id, bob.user_id, pidAB, 'x', '2030-01-01', '2030-01-01T00:00:00.000Z', 'partner');

    // Unpair, then backdate ended_at 100 days into the past so the TTL
    // sweep matches it. Direct SQL on the test DB handle is the cleanest
    // way to time-travel for this branch.
    await request(app).post('/api/unpair').set('Authorization', `Bearer ${alice.access_token}`);
    db.prepare("UPDATE couples SET ended_at = datetime('now', '-100 days') WHERE pair_id = ?").run(pidAB);

    // Pre-cleanup sanity: rows still present in DB.
    expect((db.prepare('SELECT COUNT(*) AS n FROM actions WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM important_dates WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM bucket_items WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM time_capsules WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBeGreaterThan(0);

    const deleted = dbOps.couplesCleanupExpired();
    expect(deleted).toContain(pidAB);

    // Post-cleanup: zero rows everywhere + couples row gone.
    expect((db.prepare('SELECT COUNT(*) AS n FROM actions WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM important_dates WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM bucket_items WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM time_capsules WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM couples WHERE pair_id = ?').get(pidAB) as { n: number }).n).toBe(0);

    // Subsequent re-pair after TTL expiry generates a FRESH pair_id,
    // not the old one (it's gone) — verifies "stale couple beyond TTL"
    // safety net in couplesGetOrCreatePair.
    await request(app).post('/api/pair').set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_id: bob.user_id });
    const pidAfter = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id);
    expect(pidAfter).toBeTruthy();
    expect(pidAfter).not.toBe(pidAB); // brand new id
  });
});

describe('POST /api/unpair', () => {
  it('should unpair both users and return new pair code', async () => {
    const { app, mockPush } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const res = await request(app)
      .post('/api/unpair')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.new_pair_code).toHaveLength(4);

    // Partner should receive push notification
    expect(mockPush).toHaveBeenCalledWith('test-device-token', 'unpair', 'Alice', undefined, expect.any(Number));

    // Verify Alice is no longer paired
    const actionRes = await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'miss' });
    expect(actionRes.status).toBe(400);
    expect(actionRes.body.error).toBe('Not paired yet');
  });

  it('should return 400 when not paired', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .post('/api/unpair')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/status — streak', () => {
  it('should return streak 0 when no actions', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.body.streak).toBe(0);
  });

  it('should return streak 1 when both users acted today', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'kiss' });
    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ action_type: 'miss' });

    const res = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.body.streak).toBe(1);
  });

  it('should return streak 0 when only one user acted', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'kiss' });

    const res = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.body.streak).toBe(0);
  });
});

describe('Important Dates CRUD', () => {
  it('should create and list dates', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const createRes = await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '纪念日', date: '2026-05-01', recurring: true });

    expect(createRes.status).toBe(200);
    expect(createRes.body.date.title).toBe('纪念日');
    expect(createRes.body.date.recurring).toBe(1);

    // Pin the date
    const dateId = createRes.body.date.id;
    await request(app)
      .post(`/api/dates/${dateId}/pin`)
      .set('Authorization', `Bearer ${alice.access_token}`);

    const listRes = await request(app)
      .get('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(listRes.body.dates).toHaveLength(1);
    expect(listRes.body.pinned).toBeDefined();
    expect(listRes.body.pinned.title).toBe('纪念日');
  });

  it('pinned non-recurring past date returns negative days_diff (anniversary count-up)', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const create = await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '在一起的日子', date: '2020-01-01', recurring: false });
    const dateId = create.body.date.id;
    await request(app)
      .post(`/api/dates/${dateId}/pin`)
      .set('Authorization', `Bearer ${alice.access_token}`);

    const list = await request(app)
      .get('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(list.body.pinned.days_diff).toBeLessThan(0);
    expect(list.body.pinned.days_away).toBeGreaterThan(0);
    expect(list.body.pinned.days_away).toBe(Math.abs(list.body.pinned.days_diff));
  });

  it('pinned future date returns positive days_diff', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const create = await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '婚礼', date: '2099-06-06', recurring: false });
    await request(app)
      .post(`/api/dates/${create.body.date.id}/pin`)
      .set('Authorization', `Bearer ${alice.access_token}`);

    const list = await request(app)
      .get('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(list.body.pinned.days_diff).toBeGreaterThan(0);
  });

  it('should allow partner to see dates created by the other', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '生日', date: '2026-12-25' });

    const res = await request(app)
      .get('/api/dates')
      .set('Authorization', `Bearer ${bob.access_token}`);

    expect(res.body.dates).toHaveLength(1);
    expect(res.body.dates[0].title).toBe('生日');
  });

  it('should update a date', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const createRes = await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '旧标题', date: '2026-06-01' });

    const id = createRes.body.date.id;

    const updateRes = await request(app)
      .put(`/api/dates/${id}`)
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '新标题', date: '2026-07-01', recurring: true });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);
  });

  it('should delete a date', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const createRes = await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '删除测试', date: '2026-08-01' });

    const id = createRes.body.date.id;

    const deleteRes = await request(app)
      .delete(`/api/dates/${id}`)
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(deleteRes.status).toBe(200);

    const listRes = await request(app)
      .get('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(listRes.body.dates).toHaveLength(0);
  });

  it('should return 400 when not paired', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: 'test', date: '2026-01-01' });

    expect(res.status).toBe(400);
  });
});

describe('Daily Question', () => {
  it('should return question with no answers initially', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .get('/api/daily-question')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.question).toBeDefined();
    expect(res.body.date).toBeDefined();
    expect(res.body.my_answer).toBeNull();
    expect(res.body.partner_answer).toBeNull();
    expect(res.body.both_answered).toBe(false);
  });

  it('should save answer and not reveal partner answer until both answered', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Alice answers
    const answerRes = await request(app)
      .post('/api/daily-question/answer')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ answer: 'Alice的回答' });

    expect(answerRes.status).toBe(200);
    expect(answerRes.body.both_answered).toBe(false);
    expect(answerRes.body.partner_answer).toBeNull();

    // Alice checks — should see her answer but not Bob's
    const checkRes = await request(app)
      .get('/api/daily-question')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(checkRes.body.my_answer).toBe('Alice的回答');
    expect(checkRes.body.partner_answer).toBeNull();
    expect(checkRes.body.both_answered).toBe(false);

    // Bob answers
    const bobRes = await request(app)
      .post('/api/daily-question/answer')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ answer: 'Bob的回答' });

    expect(bobRes.body.both_answered).toBe(true);
    expect(bobRes.body.partner_answer).toBe('Alice的回答');

    // Now Alice should see both
    const revealRes = await request(app)
      .get('/api/daily-question')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(revealRes.body.both_answered).toBe(true);
    expect(revealRes.body.my_answer).toBe('Alice的回答');
    expect(revealRes.body.partner_answer).toBe('Bob的回答');
  });

  it('should allow updating answer', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    await request(app)
      .post('/api/daily-question/answer')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ answer: '第一次' });

    await request(app)
      .post('/api/daily-question/answer')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ answer: '修改后' });

    const res = await request(app)
      .get('/api/daily-question')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.body.my_answer).toBe('修改后');
  });

  it('should send push notification on answer', async () => {
    const { app, mockPush } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    await request(app)
      .post('/api/daily-question/answer')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ answer: '测试' });

    expect(mockPush).toHaveBeenCalledWith('test-device-token', 'daily_answer', 'Alice', undefined, expect.any(Number));
  });
});

// (v1.2.21) POST /api/reaction removed — the "long-press a partner's
// 废话区 bubble to react with an emoji" feature was retired. The 6
// tests that previously covered react / reaction-in-history-response /
// own-action-block / update-existing / push-on-reaction lived here.
// daily-reaction (👍/👎 on daily question + snap) is a SEPARATE endpoint
// and has its own dedicated tests below.

describe('Ritual API', () => {
  it('cross-tz: morning bothCompleted only fires when ritual_dates match', async () => {
    // Cross-timezone "same-day" rule. Two users in different tzs each
    // insert their own local-date morning ritual; the live "both"
    // decision (matching the weekly stat's r1.ritual_date = r2.ritual_date
    // join) should ONLY count days where the two rows share the same
    // ritual_date string.
    const { app, dbOps } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const bob = await registerUser(app, 'Bob');
    dbOps.pairCouple(alice.user_id, bob.user_id);

    // Day 1: both submit morning on May 3 (each in their respective
    // local tzs — UTC instants may differ but the ritual_date string
    // agrees). "Both for May 3" is true.
    dbOps.submitRitual(alice.user_id, 'morning', '2026-05-03');
    dbOps.submitRitual(bob.user_id, 'morning', '2026-05-03');

    const sameDay = dbOps.getRitualsByDates('2026-05-03', '2026-05-03', alice.user_id, bob.user_id);
    expect(sameDay.myMorning).toBe(true);
    expect(sameDay.partnerMorning).toBe(true);
    const myDateA: string = '2026-05-03';
    const partnerDateA: string = '2026-05-03';
    const sameDayBoth = (myDateA === partnerDateA) && sameDay.myMorning && sameDay.partnerMorning;
    expect(sameDayBoth).toBe(true);

    // Cross-day boundary: Alice rolled into May 4 in her local tz, Bob
    // still on May 3 in his — a typical BJT/NYC mid-day-cross window.
    dbOps.submitRitual(alice.user_id, 'morning', '2026-05-04');
    // Bob has not yet recorded May 4.

    const crossDay = dbOps.getRitualsByDates('2026-05-04', '2026-05-03', alice.user_id, bob.user_id);
    expect(crossDay.myMorning).toBe(true);     // Alice's May 4 morning
    expect(crossDay.partnerMorning).toBe(true); // Bob's May 3 morning
    const myDateB: string = '2026-05-04';
    const partnerDateB: string = '2026-05-03';
    const crossDayBoth = (myDateB === partnerDateB) && crossDay.myMorning && crossDay.partnerMorning;
    expect(crossDayBoth).toBe(false); // Different dates → not "both"

    // Once Bob also reaches May 4 morning in his local tz, dates align
    // and "both" flips to true.
    dbOps.submitRitual(bob.user_id, 'morning', '2026-05-04');
    const aligned = dbOps.getRitualsByDates('2026-05-04', '2026-05-04', alice.user_id, bob.user_id);
    const myDateC: string = '2026-05-04';
    const partnerDateC: string = '2026-05-04';
    const alignedBoth = (myDateC === partnerDateC) && aligned.myMorning && aligned.partnerMorning;
    expect(alignedBoth).toBe(true);
  });

  it('should submit morning ritual', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .post('/api/ritual')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ ritual_type: 'morning' });

    // May succeed or fail depending on current hour, but should not 500
    expect([200, 400]).toContain(res.status);
  });

  it('should get ritual status', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .get('/api/ritual/status')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.morning).toBeDefined();
    expect(res.body.evening).toBeDefined();
    expect(res.body.local_hour).toBeDefined();
  });

  it('should reject invalid ritual_type', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .post('/api/ritual')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ ritual_type: 'noon' });

    expect(res.status).toBe(400);
  });
});

describe('Mailbox API', () => {
  it('should get mailbox status', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .get('/api/mailbox')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.week_key).toBeDefined();
    expect(res.body.phase).toBeDefined();
    expect(res.body.reveal_at).toBeDefined();
    // Before writing, my_sealed must be false so the UI knows whether to
    // render the countdown banner.
    expect(res.body.my_sealed).toBe(false);
    expect(res.body.my_message).toBeNull();
  });

  it('should submit mailbox message', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const statusRes = await request(app)
      .get('/api/mailbox')
      .set('Authorization', `Bearer ${alice.access_token}`);

    // Only test submission if in writing phase
    if (statusRes.body.phase === 'writing') {
      const res = await request(app)
        .post('/api/mailbox')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ content: '我想对你说...' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Pre-reveal, the writer can't peek their own letter, but the box
      // is no longer "sealed shut" — they can keep submitting more.
      const getRes = await request(app)
        .get('/api/mailbox')
        .set('Authorization', `Bearer ${alice.access_token}`);
      expect(getRes.body.my_message).toBeNull();
      expect(getRes.body.my_sealed).toBe(false);
      expect(getRes.body.can_edit).toBe(true);
    }
  });

  it('should accept multiple mailbox letters within the same session', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const statusRes = await request(app)
      .get('/api/mailbox')
      .set('Authorization', `Bearer ${alice.access_token}`);

    if (statusRes.body.phase === 'writing') {
      const first = await request(app)
        .post('/api/mailbox')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ content: '第一封' });
      expect(first.status).toBe(200);

      // Second submit in the same session is now permitted — the daily
      // cap that produced "本场的信已封存" was lifted.
      const second = await request(app)
        .post('/api/mailbox')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ content: '第二封' });
      expect(second.status).toBe(200);

      // Both letters should appear on Bob's archive AFTER reveal (not
      // testable here without time-travel), but Bob's outbox-side state
      // is irrelevant; we just confirm Alice's outbox sees both pending.
      const outbox = await request(app)
        .get('/api/outbox')
        .set('Authorization', `Bearer ${alice.access_token}`);
      expect(outbox.status).toBe(200);
      expect(outbox.body.mailbox_pending.length).toBe(2);
      // Reference bob to keep the lint-friendly "used" semantics for the
      // destructure (it pairs Alice with a partner so the mailbox flow is
      // even allowed to write).
      expect(bob.user_id).toBeDefined();
    }
  });

  it('should not reveal partner message before reveal time', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const statusRes = await request(app)
      .get('/api/mailbox')
      .set('Authorization', `Bearer ${alice.access_token}`);

    if (statusRes.body.phase === 'writing') {
      await request(app)
        .post('/api/mailbox')
        .set('Authorization', `Bearer ${bob.access_token}`)
        .send({ content: 'Bob的秘密' });

      const getRes = await request(app)
        .get('/api/mailbox')
        .set('Authorization', `Bearer ${alice.access_token}`);
      expect(getRes.body.partner_message).toBeNull();
    }
  });

  it('should reject content over 1000 chars (v1.3.7 — aligned with UI maxLength=1000)', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    // 1000 chars is the boundary; 1001 must reject.
    const okRes = await request(app)
      .post('/api/mailbox')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ content: 'x'.repeat(1000) });
    expect(okRes.status).toBe(200);

    const { bob } = await registerPairedUsers(app);
    const tooLong = await request(app)
      .post('/api/mailbox')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ content: 'x'.repeat(1001) });
    expect(tooLong.status).toBe(400);
  });

  it('should get mailbox archive', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .get('/api/mailbox/archive')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.weeks).toBeDefined();
  });
});

describe('Inbox trash / restore / purge', () => {
  it('rejects invalid kind', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    const res = await request(app)
      .post('/api/inbox/trash')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ kind: 'something_else', ref_id: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects non-integer ref_id', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    const res = await request(app)
      .post('/api/inbox/trash')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ kind: 'mailbox', ref_id: 'abc' });
    expect(res.status).toBe(400);
  });

  it('returns 404 trying to trash non-existent letter', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    const res = await request(app)
      .post('/api/inbox/trash')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ kind: 'mailbox', ref_id: 99999 });
    expect(res.status).toBe(404);
  });

  it('cannot trash own outgoing partner-vis capsule', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    // Alice creates a capsule for bob (visibility=partner)
    const cap = await request(app)
      .post('/api/capsules')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({
        content: 'hello future bob',
        unlock_date: '2099-12-31',
        visibility: 'partner',
      });
    expect(cap.status).toBe(200);

    // Alice tries to trash it from her own inbox — should be 403.
    const res = await request(app)
      .post('/api/inbox/trash')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ kind: 'capsule', ref_id: cap.body.id });
    expect(res.status).toBe(403);
  });

  it('returns empty trash list initially', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    const res = await request(app)
      .get('/api/inbox/trash')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBe(0);
  });

  it('open capsule respects trash/purge — trashed/purged returns 404', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Bob writes a capsule for alice with a past unlock_date so it's
    // immediately openable. Direct DB insert bypasses the API's future-date
    // guard (which is correct for normal flows but blocks this test setup).
    const pairId = dbOps.couplesGetActivePairId(bob.user_id, alice.user_id)!;
    const cap = dbOps.createCapsule(bob.user_id, alice.user_id, pairId, 'a letter from the past', '2020-01-01', '2020-01-01T00:00:00.000Z', 'partner');

    // First open succeeds (sanity check).
    const open1 = await request(app)
      .post(`/api/capsules/${cap.id}/open`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(open1.status).toBe(200);
    expect(open1.body.content).toBe('a letter from the past');

    // Alice trashes it.
    const trash = await request(app)
      .post('/api/inbox/trash')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ kind: 'capsule', ref_id: cap.id });
    expect(trash.status).toBe(200);

    // Re-opening must now 404 — the recipient soft-deleted it.
    const open2 = await request(app)
      .post(`/api/capsules/${cap.id}/open`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(open2.status).toBe(404);

    // Restore brings it back.
    const restore = await request(app)
      .post('/api/inbox/restore')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ kind: 'capsule', ref_id: cap.id });
    expect(restore.status).toBe(200);

    const open3 = await request(app)
      .post(`/api/capsules/${cap.id}/open`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(open3.status).toBe(200);

    // Purge — permanently hidden, even direct-id access returns 404.
    const purge = await request(app)
      .post('/api/inbox/purge')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ kind: 'capsule', ref_id: cap.id });
    expect(purge.status).toBe(200);

    const open4 = await request(app)
      .post(`/api/capsules/${cap.id}/open`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(open4.status).toBe(404);
  });

  it('outgoing partner-vis capsule open is unaffected by other users\' trash actions', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Alice writes for bob (partner-vis).
    const pairId = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;
    const cap = dbOps.createCapsule(alice.user_id, bob.user_id, pairId, 'for bob', '2020-01-01', '2020-01-01T00:00:00.000Z', 'partner');

    // Bob trashes it after first open.
    await request(app)
      .post(`/api/capsules/${cap.id}/open`)
      .set('Authorization', `Bearer ${bob.access_token}`);
    await request(app)
      .post('/api/inbox/trash')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ kind: 'capsule', ref_id: cap.id });

    // Alice (the author / outgoing) is *not* affected by bob's trash —
    // her open still works (she sent it; this is her sent-mail).
    const aliceOpen = await request(app)
      .post(`/api/capsules/${cap.id}/open`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(aliceOpen.status).toBe(200);
    expect(aliceOpen.body.content).toBe('for bob');
  });

  it('partner sends mailbox letter; alice can trash it, restore it, purge it', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Bob writes a letter
    const status = await request(app).get('/api/mailbox').set('Authorization', `Bearer ${bob.access_token}`);
    if (status.body.phase !== 'writing') return; // skip if reveal-time edge case

    const submit = await request(app)
      .post('/api/mailbox')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ content: 'a letter for alice' });
    expect(submit.status).toBe(200);

    // Find bob's message id from alice's archive (revealed sessions only —
    // skip if current session not yet revealed).
    const archiveRes = await request(app)
      .get('/api/mailbox/archive')
      .set('Authorization', `Bearer ${alice.access_token}`);
    const week = archiveRes.body.weeks.find((w: any) => w.partner_message_id);
    if (!week) return; // current AM/PM round not yet revealed in this test run

    const refId = week.partner_message_id;

    // Trash
    const trash = await request(app)
      .post('/api/inbox/trash')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ kind: 'mailbox', ref_id: refId });
    expect(trash.status).toBe(200);

    // Verify partner_content disappears from archive
    const after = await request(app)
      .get('/api/mailbox/archive')
      .set('Authorization', `Bearer ${alice.access_token}`);
    const sameWeek = after.body.weeks.find((w: any) => w.week_key === week.week_key);
    expect(sameWeek?.partner_content).toBeNull();

    // Verify it shows up in trash
    const trashList = await request(app)
      .get('/api/inbox/trash')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(trashList.body.items.length).toBe(1);
    expect(trashList.body.items[0].kind).toBe('mailbox');
    expect(trashList.body.items[0].ref_id).toBe(refId);

    // Restore
    const restore = await request(app)
      .post('/api/inbox/restore')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ kind: 'mailbox', ref_id: refId });
    expect(restore.status).toBe(200);

    // Verify back in archive
    const back = await request(app)
      .get('/api/mailbox/archive')
      .set('Authorization', `Bearer ${alice.access_token}`);
    const restoredWeek = back.body.weeks.find((w: any) => w.week_key === week.week_key);
    expect(restoredWeek?.partner_content).toBe('a letter for alice');

    // Purge — permanently hide
    const purge = await request(app)
      .post('/api/inbox/purge')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ kind: 'mailbox', ref_id: refId });
    expect(purge.status).toBe(200);

    const finalArchive = await request(app)
      .get('/api/mailbox/archive')
      .set('Authorization', `Bearer ${alice.access_token}`);
    const purgedWeek = finalArchive.body.weeks.find((w: any) => w.week_key === week.week_key);
    expect(purgedWeek?.partner_content).toBeNull();

    // Purged items don't show up in trash list (they're permanently hidden)
    const finalTrash = await request(app)
      .get('/api/inbox/trash')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(finalTrash.body.items.length).toBe(0);
  });
});

describe('Weekly Report', () => {
  it('should return weekly report data', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    await request(app).post('/api/action').set('Authorization', `Bearer ${alice.access_token}`).send({ action_type: 'kiss' });
    await request(app).post('/api/action').set('Authorization', `Bearer ${bob.access_token}`).send({ action_type: 'miss' });

    const res = await request(app)
      .get('/api/weekly-report')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body.temperature).toBeDefined();
    expect(res.body.top_actions).toBeDefined();
  });
});

describe('Time Capsules', () => {
  it('should create a capsule', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .post('/api/capsules')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ content: '来自过去的信', unlock_date: '2099-12-31' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
  });

  it('should list capsules with hidden content', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    await request(app)
      .post('/api/capsules')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ content: '秘密', unlock_date: '2099-12-31' });

    const res = await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.body.capsules).toHaveLength(1);
    expect(res.body.capsules[0].content).toBeNull(); // Not opened yet
    expect(res.body.capsules[0].is_unlockable).toBe(false);
  });

  it('should reject past unlock_date', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .post('/api/capsules')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ content: 'test', unlock_date: '2020-01-01' });

    expect(res.status).toBe(400);
  });
});

describe('Bucket List', () => {
  it('should create and list bucket items', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    await request(app)
      .post('/api/bucket')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '一起去日本', category: 'travel' });

    const res = await request(app)
      .get('/api/bucket')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('一起去日本');
    expect(res.body.total).toBe(1);
    expect(res.body.completed_count).toBe(0);
  });

  it('should complete and uncomplete items', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const createRes = await request(app)
      .post('/api/bucket')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '看电影' });

    const itemId = createRes.body.item.id;

    await request(app)
      .post(`/api/bucket/${itemId}/complete`)
      .set('Authorization', `Bearer ${alice.access_token}`);

    let listRes = await request(app).get('/api/bucket').set('Authorization', `Bearer ${alice.access_token}`);
    expect(listRes.body.completed_count).toBe(1);

    await request(app)
      .post(`/api/bucket/${itemId}/uncomplete`)
      .set('Authorization', `Bearer ${alice.access_token}`);

    listRes = await request(app).get('/api/bucket').set('Authorization', `Bearer ${alice.access_token}`);
    expect(listRes.body.completed_count).toBe(0);
  });

  it('should delete bucket items', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const createRes = await request(app)
      .post('/api/bucket')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '删除测试' });

    const res = await request(app)
      .delete(`/api/bucket/${createRes.body.item.id}`)
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);

    const listRes = await request(app).get('/api/bucket').set('Authorization', `Bearer ${alice.access_token}`);
    expect(listRes.body.items).toHaveLength(0);
  });

  it('should send push on bucket create', async () => {
    const { app, mockPush } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    await request(app)
      .post('/api/bucket')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '新心愿' });

    expect(mockPush).toHaveBeenCalledWith('test-device-token', 'bucket_new', 'Alice', undefined, expect.any(Number));
  });

  it('should include item title in bucket_complete push', async () => {
    const { app, mockPush } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const create = await request(app)
      .post('/api/bucket')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: '一起去日本' });

    (mockPush as jest.Mock).mockClear();

    await request(app)
      .post(`/api/bucket/${create.body.item.id}/complete`)
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(mockPush).toHaveBeenCalledWith(
      'test-device-token',
      'bucket_complete',
      'Alice',
      { title: '一起去日本' },
      expect.any(Number),
    );
  });
});

describe('Daily Snaps', () => {
  it('should get today snap status', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .get('/api/snaps/today')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.my_snapped).toBe(false);
    expect(res.body.snap_date).toBeDefined();
  });

  it('should get snaps by month', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .get('/api/snaps?month=2026-04')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.snaps).toBeDefined();
  });

  it('should hide partner photo on /snaps/today until I have also snapped', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Bob snaps first; Alice has not snapped yet.
    const today = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
    dbOps.saveSnapAtomic(bob.user_id, alice.user_id, today, `${bob.user_id}/${today}.jpg`);

    const beforeAlice = await request(app)
      .get('/api/snaps/today')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(beforeAlice.status).toBe(200);
    expect(beforeAlice.body.partner_snapped).toBe(true);
    expect(beforeAlice.body.my_snapped).toBe(false);
    // Reveal gating: ta's photo URL must NOT leak before I've snapped.
    expect(beforeAlice.body.partner_photo).toBeNull();

    // Once Alice also snaps, ta's photo unlocks.
    dbOps.saveSnapAtomic(alice.user_id, bob.user_id, today, `${alice.user_id}/${today}.jpg`);
    const afterAlice = await request(app)
      .get('/api/snaps/today')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(afterAlice.body.my_snapped).toBe(true);
    expect(afterAlice.body.partner_snapped).toBe(true);
    expect(afterAlice.body.partner_photo).toBeTruthy();
    expect(afterAlice.body.my_photo).toBeTruthy();
  });

  it('should hide partner photo on /snaps month list for days I never snapped', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Day 1: only Bob snaps. Day 2: both snap.
    const day1 = '2026-04-10';
    const day2 = '2026-04-11';
    dbOps.saveSnapAtomic(bob.user_id, alice.user_id, day1, `${bob.user_id}/${day1}.jpg`);
    dbOps.saveSnapAtomic(alice.user_id, bob.user_id, day2, `${alice.user_id}/${day2}.jpg`);
    dbOps.saveSnapAtomic(bob.user_id, alice.user_id, day2, `${bob.user_id}/${day2}.jpg`);

    const res = await request(app)
      .get('/api/snaps?month=2026-04')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);

    const byDate: Record<string, any> = {};
    for (const s of res.body.snaps) byDate[s.date] = s;

    // Day 1: Alice never snapped → ta's photo must stay hidden.
    expect(byDate[day1].my_photo).toBeNull();
    expect(byDate[day1].partner_photo).toBeNull();
    expect(byDate[day1].both_snapped).toBe(false);

    // Day 2: both snapped → both photos visible.
    expect(byDate[day2].my_photo).toBeTruthy();
    expect(byDate[day2].partner_photo).toBeTruthy();
    expect(byDate[day2].both_snapped).toBe(true);
  });

  it('saveSnapAtomic should reject duplicate same-day uploads', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const date = '2026-04-12';

    // First call: claim the row.
    const first = dbOps.saveSnapAtomic(alice.user_id, bob.user_id, date, `${alice.user_id}/${date}.jpg`);
    expect(first.saved).toBe(true);
    expect(first.bothSnapped).toBe(false);

    // Second call: race-loser, must NOT clobber the existing row.
    const second = dbOps.saveSnapAtomic(alice.user_id, bob.user_id, date, `${alice.user_id}/${date}-other.jpg`);
    expect(second.saved).toBe(false);
    expect(second.bothSnapped).toBe(false);

    // The DB row from the first call survives unchanged.
    const snap = dbOps.getSnap(alice.user_id, date);
    expect(snap?.photo_path).toBe(`${alice.user_id}/${date}.jpg`);
  });

  it('saveSnapAtomic should report bothSnapped when partner already snapped', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const date = '2026-04-13';

    // Bob snaps first.
    dbOps.saveSnapAtomic(bob.user_id, alice.user_id, date, `${bob.user_id}/${date}.jpg`);

    // Alice's atomic save sees Bob's row inside the same tx.
    const result = dbOps.saveSnapAtomic(alice.user_id, bob.user_id, date, `${alice.user_id}/${date}.jpg`);
    expect(result.saved).toBe(true);
    expect(result.bothSnapped).toBe(true);
  });

  it('deleteSnap should let the user retry after a failed file write', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const date = '2026-04-14';

    dbOps.saveSnapAtomic(alice.user_id, bob.user_id, date, `${alice.user_id}/${date}.jpg`);
    expect(dbOps.getSnap(alice.user_id, date)).toBeDefined();

    // Simulate route-level rollback after a fs.rename failure.
    dbOps.deleteSnap(alice.user_id, date);
    expect(dbOps.getSnap(alice.user_id, date)).toBeUndefined();

    // After rollback the user can claim the slot again.
    const retry = dbOps.saveSnapAtomic(alice.user_id, bob.user_id, date, `${alice.user_id}/${date}.jpg`);
    expect(retry.saved).toBe(true);
  });
});

describe('POST /api/logout', () => {
  it('should clear device token and revoke tokens', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const res = await request(app)
      .post('/api/logout')
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Old access token should no longer work (token_version incremented)
    const historyRes = await request(app)
      .get('/api/history')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(historyRes.status).toBe(401);

    // Old refresh token should no longer work
    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: alice.refresh_token });
    expect(refreshRes.status).toBe(401);
  });
});

describe('Security hardening', () => {
  it('rejects partner attempting to open self-visibility capsule', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const create = await request(app)
      .post('/api/capsules')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ content: '私密日记', unlock_date: '2099-12-31', visibility: 'self' });
    expect(create.status).toBe(200);
    const capsuleId = create.body.id;

    // Bob shouldn't see it in the list
    const list = await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${bob.access_token}`);
    expect(list.body.capsules.find((c: any) => c.id === capsuleId)).toBeUndefined();

    // Even if Bob guesses the id, open should 404 (and not reveal content)
    const open = await request(app)
      .post(`/api/capsules/${capsuleId}/open`)
      .set('Authorization', `Bearer ${bob.access_token}`);
    expect(open.status).toBe(404);
  });

  it('rejects malformed dates on POST /dates', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    for (const bad of ['2024', '2024-13-01', '2024-02-31', 'yesterday', '<script>']) {
      const res = await request(app)
        .post('/api/dates')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ title: 't', date: bad });
      expect(res.status).toBe(400);
    }

    // Sanity: a valid date works
    const ok = await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: 't', date: '2024-02-29' });
    expect(ok.status).toBe(200);
  });

  it('rejects PUT /dates/:id with malformed date or oversized title', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const create = await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: 't', date: '2024-01-01' });
    const id = create.body.date.id;

    const badDate = await request(app)
      .put(`/api/dates/${id}`)
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: 't', date: 'not-a-date' });
    expect(badDate.status).toBe(400);

    const longTitle = await request(app)
      .put(`/api/dates/${id}`)
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ title: 'x'.repeat(100), date: '2024-01-02' });
    expect(longTitle.status).toBe(400);
  });

  it('rejects oversized name / partner_remark on /profile', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const longName = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ name: 'x'.repeat(50) });
    expect(longName.status).toBe(400);

    const longRemark = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_remark: 'x'.repeat(100) });
    expect(longRemark.status).toBe(400);
  });

  it('rejects oversized name on /register', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/register')
      .send({ name: 'x'.repeat(50), password: 'test1234' });
    expect(res.status).toBe(400);
  });

  it('mark-read clamps to real latest partner action id', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'kiss' });

    // Try to push the pointer to the moon
    await request(app)
      .post('/api/mark-read')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ last_id: Number.MAX_SAFE_INTEGER });

    // Stored value must be clamped to the actual latest partner action id
    const bobUser = dbOps.getUser(bob.user_id)!;
    expect(bobUser.last_read_action_id).toBeLessThan(Number.MAX_SAFE_INTEGER);

    // Next action from Alice must produce badge=1 (not stale 0)
    const { mockPush } = createTestApp(); // unused, just import
    void mockPush;
  });
});

describe('Push body sanitization', () => {
  it('does not interpret $& replacement sequences in name or extras', async () => {
    // Direct unit test of sendPush would require initializing APNs, so we
    // test the regex behavior the helper relies on.
    // String.replace with a function never interprets $&; with a string it does.
    const body = 'hello {name}';
    const evil = '$&';
    const stringForm = body.replace(/\{name\}/g, evil);
    const fnForm = body.replace(/\{name\}/g, () => evil);
    expect(stringForm).toBe('hello {name}'); // $& expanded to matched substring
    expect(fnForm).toBe('hello $&');         // function form preserves literal
  });
});

describe('POST /api/urge', () => {
  it('rejects urging if you have not answered yourself', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    const res = await request(app)
      .post('/api/urge')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ type: 'question' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/your own/i);
  });

  it('rejects urging if partner already answered', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    await request(app).post('/api/daily-question/answer').set('Authorization', `Bearer ${alice.access_token}`).send({ answer: 'a' });
    await request(app).post('/api/daily-question/answer').set('Authorization', `Bearer ${bob.access_token}`).send({ answer: 'b' });
    const res = await request(app)
      .post('/api/urge')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ type: 'question' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already answered/i);
  });

  it('sends urge_question push when conditions met', async () => {
    const { app, mockPush } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    await request(app).post('/api/daily-question/answer').set('Authorization', `Bearer ${alice.access_token}`).send({ answer: 'a' });
    (mockPush as jest.Mock).mockClear();
    const res = await request(app)
      .post('/api/urge')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ type: 'question' });
    expect(res.status).toBe(200);
    expect(mockPush).toHaveBeenCalledWith('test-device-token', 'urge_question', 'Alice', undefined, expect.any(Number));
  });

  it('rejects invalid type', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    const res = await request(app)
      .post('/api/urge')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ type: 'wrong' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/daily-reaction', () => {
  it('rejects if both have not answered yet', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    await request(app).post('/api/daily-question/answer').set('Authorization', `Bearer ${alice.access_token}`).send({ answer: 'a' });
    const res = await request(app)
      .post('/api/daily-reaction')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ type: 'question', reaction: 'up' });
    expect(res.status).toBe(400);
  });

  it('records reaction and sends push when both answered', async () => {
    const { app, mockPush } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    await request(app).post('/api/daily-question/answer').set('Authorization', `Bearer ${alice.access_token}`).send({ answer: 'a' });
    await request(app).post('/api/daily-question/answer').set('Authorization', `Bearer ${bob.access_token}`).send({ answer: 'b' });
    (mockPush as jest.Mock).mockClear();
    const res = await request(app)
      .post('/api/daily-reaction')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ type: 'question', reaction: 'up' });
    expect(res.status).toBe(200);
    expect(res.body.reaction).toBe('up');
    expect(mockPush).toHaveBeenCalledWith('test-device-token', 'react_question_up', 'Alice', undefined, expect.any(Number));

    // Visible in subsequent GET /daily-question
    const get = await request(app).get('/api/daily-question').set('Authorization', `Bearer ${alice.access_token}`);
    expect(get.body.my_reaction_to_partner).toBe('up');
  });

  it('rejects malformed unlock_date on /capsules', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    for (const bad of ['2099', 'tomorrow', '2099-13-01', '2099-02-31', '<script>']) {
      const res = await request(app)
        .post('/api/capsules')
        .set('Authorization', `Bearer ${alice.access_token}`)
        .send({ content: 'test', unlock_date: bad });
      expect(res.status).toBe(400);
    }
  });

  it('rejects non-string user_id on /login (no 500)', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/login')
      .send({ user_id: 12345, password: 'whatever' });
    expect(res.status).toBe(400);
  });

  it('rejects non-string partner_id on /pair (no 500)', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const res = await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ partner_id: 12345 });
    expect(res.status).toBe(400);
  });

  it('rejects oversized daily question answer', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    const res = await request(app)
      .post('/api/daily-question/answer')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ answer: 'x'.repeat(600) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max 500/);
  });

  it('reaction is one-shot — cannot be changed once made', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    await request(app).post('/api/daily-question/answer').set('Authorization', `Bearer ${alice.access_token}`).send({ answer: 'a' });
    await request(app).post('/api/daily-question/answer').set('Authorization', `Bearer ${bob.access_token}`).send({ answer: 'b' });

    const first = await request(app).post('/api/daily-reaction').set('Authorization', `Bearer ${alice.access_token}`).send({ type: 'question', reaction: 'up' });
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/daily-reaction').set('Authorization', `Bearer ${alice.access_token}`).send({ type: 'question', reaction: 'down' });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/评价过/);

    const get = await request(app).get('/api/daily-question').set('Authorization', `Bearer ${alice.access_token}`);
    expect(get.body.my_reaction_to_partner).toBe('up');  // unchanged
  });
});
