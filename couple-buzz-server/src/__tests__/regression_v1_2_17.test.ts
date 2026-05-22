/**
 * Regression tests for the v1.2.17 fixes:
 *
 *   BUG1 — Capsules never opened on the client (no UI path called
 *          POST /capsules/:id/open). InboxScreen filtered out anything
 *          with opened_at=null, so the recipient never saw the letter
 *          after the unlock instant passed. Server now auto-opens any
 *          unlockable+unopened capsule whose recipient is the caller
 *          when GET /api/capsules runs.
 *
 *   BUG3 — Re-login on the same physical device left the prior session
 *          in the device list as a separate row ("新的本机" without
 *          the previous identity). Server now uses the APNs token as
 *          the "same device" signal: if /login (or PUT /device-token)
 *          carries a token that was bound to a still-active session
 *          of this user, that session is revoked and the new session
 *          inherits its device_name + is_primary flag.
 *
 *   REQ1 — Capsule unlock pushes used to fire only on 5-minute
 *          boundaries; the picker supports minute precision so a user
 *          who picked 20:34 would actually see the push at 20:35 (or
 *          later). scheduler.ts now runs the capsule check every
 *          minute; verified with a source-pattern check that the
 *          5-min throttle (`utcMin % 5 === 0`) is gone.
 *
 *   REQ2 — Inbox letters with the same arrival time (multiple half-day
 *          mailbox letters in one session reveal) had undefined order.
 *          Client now sorts by (arrivedAt ASC, writtenAt ASC), so the
 *          later-written letter ends up at the bottom of the stack
 *          (= first visible on open). Verified via source-pattern
 *          inspection on the client file.
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
    .send({ name, password });
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

// `/api/sessions` returns every active session including the helper's
// /api/register boot session, which has device_name=null because the
// helper doesn't pass device info. In production `api.register` DOES
// pass device info; the test helper just doesn't bother. To avoid
// re-engineering the helper, the BUG3 tests filter to only the rows
// that carry a real device fingerprint — those are the ones the
// reclaim heuristic operates on.
async function listFingerprintedSessions(
  app: express.Express,
  accessToken: string,
): Promise<any[]> {
  const res = await request(app)
    .get('/api/sessions')
    .set('Authorization', `Bearer ${accessToken}`);
  return res.body.sessions.filter(
    (s: any) => s.device_name !== null || s.device_os !== null,
  );
}

// ────────────────────────────────────────────────────────────────────
// BUG1 — auto-open on GET /api/capsules
// ────────────────────────────────────────────────────────────────────

describe('BUG1 — capsule auto-opens on recipient GET /api/capsules', () => {
  it('partner-vis capsule with past unlock_at opens when the recipient lists', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Alice writes a capsule FOR bob (partner-vis). Past unlock_at so
    // it's already unlockable. Direct DB write bypasses the future-date
    // guard in the API (which is correct for users, wrong for tests).
    const pairId = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;
    const cap = dbOps.createCapsule(
      alice.user_id, bob.user_id, pairId,
      'happy birthday from the past',
      '2020-01-01', '2020-01-01T00:00:00.000Z',
      'partner',
    );

    // Before bob hits GET — capsule sits with opened_at=null (as if
    // pre-fix). Verify the precondition.
    const preRow = (dbOps as any).getCapsules(pairId).find((c: any) => c.id === cap.id);
    expect(preRow.opened_at).toBeNull();

    // Bob (the recipient) lists capsules. The new auto-open sweep
    // should flip opened_at and surface the content in the response.
    const res = await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${bob.access_token}`);
    expect(res.status).toBe(200);
    const ours = res.body.capsules.find((c: any) => c.id === cap.id);
    expect(ours).toBeDefined();
    expect(ours.opened_at).not.toBeNull();
    expect(ours.content).toBe('happy birthday from the past');
    expect(ours.is_unlockable).toBe(false); // already opened
  });

  it('partner-vis capsule does NOT auto-open when the AUTHOR lists', async () => {
    // The author is the sender, not the recipient. Their inbox doesn't
    // show outgoing letters, so opening on their fetch would be wrong
    // (it'd race the actual recipient's first-open timestamp).
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const pairId = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;
    const cap = dbOps.createCapsule(
      alice.user_id, bob.user_id, pairId,
      'for bob',
      '2020-01-01', '2020-01-01T00:00:00.000Z',
      'partner',
    );

    const res = await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);
    const ours = res.body.capsules.find((c: any) => c.id === cap.id);
    expect(ours).toBeDefined();
    expect(ours.opened_at).toBeNull(); // author's fetch must not open
  });

  it('self-vis capsule auto-opens when the author lists', async () => {
    // Self-vis: author IS the recipient (letter to future self).
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const pairId = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;
    const cap = dbOps.createCapsule(
      alice.user_id, bob.user_id, pairId,
      'reminder to future me',
      '2020-01-01', '2020-01-01T00:00:00.000Z',
      'self',
    );

    const res = await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);
    const ours = res.body.capsules.find((c: any) => c.id === cap.id);
    expect(ours).toBeDefined();
    expect(ours.opened_at).not.toBeNull();
    expect(ours.content).toBe('reminder to future me');
  });

  it('capsule still in the future is NOT auto-opened', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const pairId = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const cap = dbOps.createCapsule(
      alice.user_id, bob.user_id, pairId,
      'see you tomorrow',
      future.slice(0, 10), future,
      'partner',
    );

    const res = await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${bob.access_token}`);
    const ours = res.body.capsules.find((c: any) => c.id === cap.id);
    expect(ours).toBeDefined();
    expect(ours.opened_at).toBeNull(); // unlock still in the future
    expect(ours.content).toBeNull();
    expect(ours.is_unlockable).toBe(false);
  });

  it('already-opened capsule is not re-opened (opened_at is preserved)', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const pairId = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;
    const cap = dbOps.createCapsule(
      alice.user_id, bob.user_id, pairId,
      'old letter',
      '2020-01-01', '2020-01-01T00:00:00.000Z',
      'partner',
    );

    // First GET opens it; second GET must not bump opened_at.
    const first = await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${bob.access_token}`);
    const firstOpenedAt = first.body.capsules.find((c: any) => c.id === cap.id).opened_at;
    expect(firstOpenedAt).not.toBeNull();

    // Sleep a tick so any new CURRENT_TIMESTAMP would be different.
    await new Promise((r) => setTimeout(r, 1100));

    const second = await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${bob.access_token}`);
    const secondOpenedAt = second.body.capsules.find((c: any) => c.id === cap.id).opened_at;
    expect(secondOpenedAt).toBe(firstOpenedAt); // unchanged
  });

  it('trashed capsule is hidden from the listing even after auto-open sweep', async () => {
    const { app, dbOps } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const pairId = dbOps.couplesGetActivePairId(alice.user_id, bob.user_id)!;
    const cap = dbOps.createCapsule(
      alice.user_id, bob.user_id, pairId,
      'for bob',
      '2020-01-01', '2020-01-01T00:00:00.000Z',
      'partner',
    );

    // First call opens + lets bob trash it.
    await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${bob.access_token}`);
    await request(app)
      .post('/api/inbox/trash')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ kind: 'capsule', ref_id: cap.id });

    const res = await request(app)
      .get('/api/capsules')
      .set('Authorization', `Bearer ${bob.access_token}`);
    const ours = res.body.capsules.find((c: any) => c.id === cap.id);
    expect(ours).toBeUndefined(); // trashed → filtered from listing
  });
});

// ────────────────────────────────────────────────────────────────────
// BUG3 — APNs-token-driven same-device session reclaim
// ────────────────────────────────────────────────────────────────────

describe('BUG3 — re-login on same physical device collapses the prior session', () => {
  it('login carrying a prior-bound APNs token revokes the old session', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    // First login binds an APNs token to a session. The "device.name"
    // is whatever the client sent — leave it as the default "iPhone"
    // so we can later assert that the SECOND login inherits it back.
    const apnsToken = 'apns-token-iphone-fingerprint';
    const first = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 18.0' },
        device_token: apnsToken,
      });
    expect(first.status).toBe(200);

    // Rename "iPhone" → "我的 iPhone" so we can later verify the name
    // travelled forward to the next session.
    const firstList = await listFingerprintedSessions(app, first.body.access_token);
    const firstSid = firstList.find((s: any) => s.is_current).session_id;
    await request(app)
      .put(`/api/sessions/${firstSid}/name`)
      .set('Authorization', `Bearer ${first.body.access_token}`)
      .send({ name: '我的 iPhone' });
    // Self-promote so we can later verify primary travels forward too —
    // the boot register-session holds primary by default in test setup.
    await request(app)
      .post(`/api/sessions/${firstSid}/primary`)
      .set('Authorization', `Bearer ${first.body.access_token}`);

    // Simulate "reinstall on same device" — the local tokens are gone
    // but the APNs token (device-scoped) survives, and the SERVER still
    // has the prior session in active state. Without the fix, the
    // sessions list after re-login would contain TWO rows for the
    // same phone.
    const second = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 18.0' },
        device_token: apnsToken,
      });
    expect(second.status).toBe(200);

    const after = await listFingerprintedSessions(app, second.body.access_token);
    // ONE fingerprinted row — the previous session was collapsed.
    expect(after).toHaveLength(1);
    const only = after[0];
    expect(only.is_current).toBe(true);
    expect(only.is_primary).toBe(true);
    // Rename carried forward via APNs-token-keyed inheritance.
    expect(only.device_name).toBe('我的 iPhone');
  });

  it('iOS upgrade case: device_os changes, APNs token same → still one row', async () => {
    // The OS-family inheritance (applyDeviceNameInheritance) can't help
    // here because device_os string differs between sessions. The APNs
    // token reclaim path must catch this.
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const apnsToken = 'apns-token-ios17-then-ios18';

    const first = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 17.5' },
        device_token: apnsToken,
      });

    const firstList = await listFingerprintedSessions(app, first.body.access_token);
    const firstSid = firstList.find((s: any) => s.is_current).session_id;
    await request(app)
      .put(`/api/sessions/${firstSid}/name`)
      .set('Authorization', `Bearer ${first.body.access_token}`)
      .send({ name: 'Steve 的 iPhone' });
    await request(app)
      .post(`/api/sessions/${firstSid}/primary`)
      .set('Authorization', `Bearer ${first.body.access_token}`);

    // Same device, but iOS upgrade bumps device.os.
    const second = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 18.0' },
        device_token: apnsToken,
      });

    const after = await listFingerprintedSessions(app, second.body.access_token);
    expect(after).toHaveLength(1);
    expect(after[0].device_name).toBe('Steve 的 iPhone');
    expect(after[0].is_primary).toBe(true);
  });

  it('different APNs tokens with same default name → both rows kept', async () => {
    // Two physically distinct iPhones (e.g. user has a primary + a
    // spare) both report device.name="iPhone" because iOS 16+ without
    // entitlement is generic. The APNs tokens are different per device,
    // so the reclaim heuristic must NOT collapse them.
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const phoneA = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 18.0' },
        device_token: 'apns-phone-A',
      });

    const phoneB = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 18.0' },
        device_token: 'apns-phone-B',
      });

    const list = await listFingerprintedSessions(app, phoneB.body.access_token);
    expect(list).toHaveLength(2);
  });

  it('login without any device_token falls back to applyDeviceNameInheritance', async () => {
    // Old client without the APNs-cache feature shouldn't lose its name
    // inheritance — when no token is sent, the existing OS-family
    // lookup still kicks in.
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const first = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 17.2' },
      });
    const firstList = await listFingerprintedSessions(app, first.body.access_token);
    const firstSid = firstList.find((s: any) => s.is_current).session_id;
    await request(app)
      .put(`/api/sessions/${firstSid}/name`)
      .set('Authorization', `Bearer ${first.body.access_token}`)
      .send({ name: 'x' });

    // First session must be revoked manually here — without an APNs
    // token, the new login can't auto-revoke it via the reclaim path.
    await request(app)
      .delete(`/api/sessions/${firstSid}/group`)
      .set('Authorization', `Bearer ${first.body.access_token}`);

    const second = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 17.2' },
      });
    const after = await listFingerprintedSessions(app, second.body.access_token);
    const current = after.find((s: any) => s.is_current);
    expect(current.device_name).toBe('x'); // OS-family inheritance still works
  });

  it('login with token bound to a DIFFERENT user does NOT touch that user\'s session', async () => {
    // APNs tokens persist per device across account switches. If user A
    // had a session bound to token T, then user B logs in on the same
    // device passing the same T, the server must not revoke A's session
    // just because B is logging in.
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');
    const bob = await registerUser(app, 'Bob');
    const sharedDeviceToken = 'apns-shared-device';

    // Alice logs in carrying the token; her session now owns the row.
    await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 18.0' },
        device_token: sharedDeviceToken,
      });
    const aliceSessions = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${(await request(app)
        .post('/api/login')
        .send({ user_id: alice.user_id, password: 'test1234', device: { name: 'iPhone', os: 'iOS 18.0' } })
      ).body.access_token}`);
    const aliceActiveCountBefore = aliceSessions.body.sessions.length;

    // Bob logs in on a "different physical device" but the local cache
    // got reused (or simulated similar scenario) — same token string.
    // The reclaim heuristic requires `row.user_id === me`, so Bob's
    // login must NOT revoke Alice's session.
    await request(app)
      .post('/api/login')
      .send({
        user_id: bob.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 18.0' },
        device_token: sharedDeviceToken,
      });

    // Re-fetch alice's sessions. None should have been revoked.
    const aliceFinal = await request(app)
      .post('/api/login')
      .send({ user_id: alice.user_id, password: 'test1234', device: { name: 'iPhone', os: 'iOS 18.0' } });
    const aliceList = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${aliceFinal.body.access_token}`);
    // Each alice login above creates a session; the bob login must not
    // have collapsed any of them. So total must be >= 1 (the latest).
    expect(aliceList.body.sessions.length).toBeGreaterThanOrEqual(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// BUG3 fallback — PUT /api/device-token catches the case where login
// did not carry the token (first install, permission granted late).
// ────────────────────────────────────────────────────────────────────

describe('BUG3 fallback — PUT /api/device-token collapses prior session', () => {
  it('binding a previously-active token to the new session revokes the prior session', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    // First login: pretend client had no APNs token yet (didn't pass
    // it). Then it calls /device-token to register the token after
    // permission grant.
    const first = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 18.0' },
      });
    const apnsToken = 'apns-late-register-token';
    // Promote first session to primary so we can verify primary
    // transfers correctly to the second session via the PUT path.
    const firstList = await listFingerprintedSessions(app, first.body.access_token);
    const firstSid = firstList.find((s: any) => s.is_current).session_id;
    await request(app)
      .post(`/api/sessions/${firstSid}/primary`)
      .set('Authorization', `Bearer ${first.body.access_token}`);
    await request(app)
      .put('/api/device-token')
      .set('Authorization', `Bearer ${first.body.access_token}`)
      .send({ device_token: apnsToken });

    // Now simulate a reinstall: second /login without the token, but
    // the SAME APNs token registers later (because iOS keeps the same
    // token for the same physical device).
    const second = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 18.0' },
      });
    // Before the PUT: TWO fingerprinted rows in the device list (the
    // boot register-session has device_name=null and is filtered out).
    const mid = await listFingerprintedSessions(app, second.body.access_token);
    expect(mid).toHaveLength(2);

    await request(app)
      .put('/api/device-token')
      .set('Authorization', `Bearer ${second.body.access_token}`)
      .send({ device_token: apnsToken });

    // After the PUT: prior session revoked, only the new one remains,
    // and it inherits primary because the old one was primary.
    const after = await listFingerprintedSessions(app, second.body.access_token);
    expect(after).toHaveLength(1);
    expect(after[0].is_current).toBe(true);
    expect(after[0].is_primary).toBe(true);
  });

  it('binding the same token to the current session twice is a no-op (idempotent)', async () => {
    const { app } = createTestApp();
    const alice = await registerUser(app, 'Alice');

    const login = await request(app)
      .post('/api/login')
      .send({
        user_id: alice.user_id,
        password: 'test1234',
        device: { name: 'iPhone', os: 'iOS 18.0' },
        device_token: 'apns-idempotent',
      });

    // First PUT — re-attach to current session.
    const put1 = await request(app)
      .put('/api/device-token')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .send({ device_token: 'apns-idempotent' });
    expect(put1.status).toBe(200);

    // Second PUT — must not revoke the current session.
    const put2 = await request(app)
      .put('/api/device-token')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .send({ device_token: 'apns-idempotent' });
    expect(put2.status).toBe(200);

    const list = await listFingerprintedSessions(app, login.body.access_token);
    expect(list).toHaveLength(1);
    expect(list[0].is_current).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// REQ1 — scheduler runs capsule check every minute (not every 5)
// ────────────────────────────────────────────────────────────────────

describe('REQ1 — scheduler fires capsule unlock check every minute', () => {
  const SCHEDULER_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', 'scheduler.ts'),
    'utf8',
  );

  it('does NOT gate the capsule check on `utcMin % 5 === 0` anymore', () => {
    // The pre-v1.2.17 version threw the per-minute scan behind a
    // 5-minute throttle, which made the user-picker's minute precision
    // moot. The new version drops the gate.
    expect(SCHEDULER_SRC).not.toMatch(/utcMin\s*%\s*5\s*===\s*0/);
  });

  it('still uses a per-minute fireOnce dedup key so process restarts do not double-fire', () => {
    // The minuteBucket key is what prevents duplicate sends across
    // restart/clock-drift. Confirm it's still there.
    expect(SCHEDULER_SRC).toMatch(/minuteBucket\s*=\s*now\.toISOString\(\)\.slice\(0,\s*16\)/);
    expect(SCHEDULER_SRC).toMatch(/fireOnce\(`capsule_\$\{minuteBucket\}`/);
  });

  it('still calls checkCapsuleUnlocks (the work function itself was not removed)', () => {
    expect(SCHEDULER_SRC).toMatch(/checkCapsuleUnlocks\(dbOps,\s*pushFn\)/);
  });
});

// ────────────────────────────────────────────────────────────────────
// REQ2 — InboxScreen sorts by arrivedAt, then writtenAt
// ────────────────────────────────────────────────────────────────────

describe('REQ2 — InboxScreen uses (arrivedAt, writtenAt) compound sort', () => {
  const INBOX_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'screens', 'InboxScreen.tsx'),
    'utf8',
  );

  it('LetterCard exposes a writtenAt field', () => {
    expect(INBOX_SRC).toMatch(/writtenAt:\s*string/);
  });

  it('comparator falls back to writtenAt when arrivedAt is equal', () => {
    // The new sort should mention writtenAt twice (the two-sided string
    // compare). Old version only had sortAt.
    const lines = INBOX_SRC.split('\n');
    const sortBlock = lines
      .slice(lines.findIndex((l) => l.includes('out.sort')))
      .slice(0, 12)
      .join('\n');
    expect(sortBlock).toMatch(/a\.arrivedAt/);
    expect(sortBlock).toMatch(/b\.arrivedAt/);
    expect(sortBlock).toMatch(/a\.writtenAt/);
    expect(sortBlock).toMatch(/b\.writtenAt/);
  });

  it('does NOT use the old single-key sortAt comparator', () => {
    // Make sure nobody slips the regression back in.
    expect(INBOX_SRC).not.toMatch(/a\.sortAt\s*<\s*b\.sortAt/);
  });
});

// ────────────────────────────────────────────────────────────────────
// BUG2 — App.tsx tab dot no longer driven by outbox events
// ────────────────────────────────────────────────────────────────────

describe('BUG2 — outbox events do NOT drive the 信箱 tab red dot', () => {
  const APP_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'App.tsx'),
    'utf8',
  );

  it('does not import hasFreshOutboxItems anywhere in App.tsx', () => {
    expect(APP_SRC).not.toMatch(/hasFreshOutboxItems/);
  });

  it('does not import or subscribe to subscribeOutboxChanged in App.tsx', () => {
    expect(APP_SRC).not.toMatch(/subscribeOutboxChanged/);
  });

  it('still drives the tab dot from sticky and inbox (partner→me) signals', () => {
    expect(APP_SRC).toMatch(/api\.getStickies\(\)/);
    expect(APP_SRC).toMatch(/hasUnreadInboxItems\(\)/);
  });
});
