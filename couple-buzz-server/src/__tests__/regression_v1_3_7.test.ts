/**
 * Regression tests for v1.3.7 — audit cleanup batch:
 *
 *   #1  Mailbox content cap raised from 500 → 1000, matching the UI's
 *       maxLength={1000}. Previously 501-1000 char letters silently
 *       failed at submit even though the counter showed "X / 1000".
 *
 *   #2  Client socket bus now forwards `daily_update`. Server emits it
 *       from /daily-question/answer, /snaps, /daily-reaction; cards
 *       subscribed but never received because socket.ts was missing
 *       the on→emit bridge. (Verified via static source pattern; the
 *       wire-level emit is already covered in pair-presence tests.)
 *
 *   #3  Front-end now ships `api.updateDate` + an edit entry point in
 *       AnniversaryWishScreen, so the long-orphaned PUT /api/dates/:id
 *       backend route is reachable from the app.
 *
 *   #4  Defense-in-depth: dbOps.getMailboxMessageById /
 *       getCapsuleById both take a pair_id and refuse to return a row
 *       whose stored pair_id is set and doesn't match the caller's.
 *       Legacy rows with NULL pair_id pass through (the row-level
 *       user_id auth check remains the gate for those).
 */

import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createDatabase } from '../db';
import { createPublicRouter, createProtectedRouter, SendPushFn } from '../routes';
import { createAuthMiddleware } from '../auth';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-testing-only';

function createTestApp() {
  const { db, dbOps } = createDatabase(':memory:');
  const mockPush: SendPushFn = jest.fn().mockResolvedValue(true);
  const app = express();
  app.use(express.json());
  app.use('/api', createPublicRouter(dbOps));
  app.use('/api', createAuthMiddleware(dbOps), createProtectedRouter(dbOps, mockPush));
  return { app, db, dbOps, mockPush };
}

async function registerUser(app: express.Express, name: string) {
  const res = await request(app)
    .post('/api/register')
    .send({ name, password: 'test1234', device_token: `${name}-token` });
  return res.body as { user_id: string; access_token: string };
}

async function pair(app: express.Express, aToken: string, bId: string) {
  await request(app)
    .post('/api/pair')
    .set('Authorization', `Bearer ${aToken}`)
    .send({ partner_id: bId });
}

async function setupPair(app: express.Express) {
  const a = await registerUser(app, 'Alice');
  const b = await registerUser(app, 'Bob');
  await pair(app, a.access_token, b.user_id);
  return { a, b };
}

// ────────────────────────────────────────────────────────────────────
// #1 — Mailbox 1000-char cap
// ────────────────────────────────────────────────────────────────────

describe('#1 — POST /api/mailbox accepts up to 1000 chars', () => {
  it('1000 chars succeeds (boundary)', async () => {
    const { app } = createTestApp();
    const { a } = await setupPair(app);
    const res = await request(app)
      .post('/api/mailbox')
      .set('Authorization', `Bearer ${a.access_token}`)
      .send({ content: 'x'.repeat(1000) });
    expect(res.status).toBe(200);
  });

  it('1001 chars rejects with the new 1000 cap in the message', async () => {
    const { app } = createTestApp();
    const { a } = await setupPair(app);
    const res = await request(app)
      .post('/api/mailbox')
      .set('Authorization', `Bearer ${a.access_token}`)
      .send({ content: 'x'.repeat(1001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1000/);
  });

  it('501-1000 range (previously 400) now succeeds — the regressing band', async () => {
    const { app } = createTestApp();
    const { a } = await setupPair(app);
    for (const n of [501, 700, 999]) {
      const res = await request(app)
        .post('/api/mailbox')
        .set('Authorization', `Bearer ${a.access_token}`)
        .send({ content: 'y'.repeat(n) });
      expect(res.status).toBe(200);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// #2 — Client socket forwards daily_update (static source check)
// ────────────────────────────────────────────────────────────────────

describe('#2 — client socket.ts forwards daily_update', () => {
  const SOCKET_SRC = fs.readFileSync(
    path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'couple-buzz-app',
      'src',
      'services',
      'socket.ts',
    ),
    'utf8',
  );

  it('subscribes to the daily_update socket event and re-emits it on the local bus', () => {
    expect(SOCKET_SRC).toMatch(
      /socket\.on\(\s*['"]daily_update['"][\s\S]*?emit\(\s*['"]daily_update['"]/,
    );
  });

  it('still forwards the other live-update events (no regression on existing wiring)', () => {
    for (const ev of [
      'touch_start',
      'touch_end',
      'partner_online',
      'presence_both',
      'presence_single',
      'action_new',
      'sticky_update',
    ]) {
      const re = new RegExp(`socket\\.on\\(\\s*['"]${ev}['"][\\s\\S]*?emit\\(\\s*['"]${ev}['"]`);
      expect(SOCKET_SRC).toMatch(re);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// #3 — Client wires PUT /api/dates/:id  (api.ts + screen entry)
// ────────────────────────────────────────────────────────────────────

describe('#3 — client exposes updateDate + edit entry in AnniversaryWishScreen', () => {
  const API_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'couple-buzz-app', 'src', 'services', 'api.ts'),
    'utf8',
  );
  const SCREEN_SRC = fs.readFileSync(
    path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'couple-buzz-app',
      'src',
      'screens',
      'AnniversaryWishScreen.tsx',
    ),
    'utf8',
  );

  it('api.ts exposes updateDate(id, title, date, recurring) targeting PUT /api/dates/:id', () => {
    expect(API_SRC).toMatch(
      /updateDate\(id:[\s\S]*?\)[\s\S]*?\/api\/dates\/\$\{id\}[\s\S]*?method:\s*['"]PUT['"]/,
    );
  });

  it('AnniversaryWishScreen wires an 编辑 button to handleStartEdit', () => {
    expect(SCREEN_SRC).toMatch(/handleStartEdit\(d\)/);
    expect(SCREEN_SRC).toMatch(/dateEdit:/);
    expect(SCREEN_SRC).toMatch(/onPress=\{\(\)\s*=>\s*handleStartEdit\(d\)\}/);
  });

  it('save handler branches on editingDate (POST vs PUT)', () => {
    expect(SCREEN_SRC).toMatch(/editingDate\s*\)/); // null-check or truthy branch
    expect(SCREEN_SRC).toMatch(/api\.updateDate\(editingDate\.id/);
    expect(SCREEN_SRC).toMatch(/api\.createDate\(title,/);
  });

  it('the backend PUT route still validates pair scope (smoke — full e2e covered elsewhere)', async () => {
    const { app } = createTestApp();
    const { a } = await setupPair(app);
    const created = await request(app)
      .post('/api/dates')
      .set('Authorization', `Bearer ${a.access_token}`)
      .send({ title: '初次见面', date: '2023-05-01', recurring: true });
    const id = created.body.date?.id;
    expect(typeof id).toBe('number');

    const updated = await request(app)
      .put(`/api/dates/${id}`)
      .set('Authorization', `Bearer ${a.access_token}`)
      .send({ title: '初次相遇', date: '2023-05-02', recurring: false });
    expect(updated.status).toBe(200);

    const list = await request(app)
      .get('/api/dates')
      .set('Authorization', `Bearer ${a.access_token}`);
    const row = list.body.dates.find((d: any) => d.id === id);
    expect(row?.title).toBe('初次相遇');
    expect(row?.date).toBe('2023-05-02');
    expect(row?.recurring).toBeFalsy();
  });
});

// ────────────────────────────────────────────────────────────────────
// #4 — Defense-in-depth: pair_id mismatch hidden at the db layer
// ────────────────────────────────────────────────────────────────────

describe('#4 — getMailboxMessageById / getCapsuleById reject cross-pair lookups', () => {
  // Tiny helper — yank the most recent mailbox row's id straight from the
  // db (the mailbox API doesn't return the new row's id, and the archive
  // endpoint is reveal-time-gated, both of which would make this test
  // depend on real-clock timing). We've already validated the auth/route
  // path here; this just gives us a concrete ref_id to feed the lookup.
  function lastMailboxId(db: any): number {
    return (db.prepare('SELECT id FROM mailbox ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  }

  it('returns the row when pair_id matches', async () => {
    const { app, db, dbOps } = createTestApp();
    const { a, b } = await setupPair(app);

    await request(app)
      .post('/api/mailbox')
      .set('Authorization', `Bearer ${b.access_token}`)
      .send({ content: 'a letter for alice' });

    const userA = dbOps.getUser(a.user_id)!;
    const pairId = dbOps.couplesGetActivePairId(a.user_id, userA.partner_id!)!;
    const refId = lastMailboxId(db);

    const row = dbOps.getMailboxMessageById(refId, pairId);
    expect(row).toBeDefined();
    expect(row?.content).toBe('a letter for alice');
    expect(row?.pair_id).toBe(pairId);
  });

  it('returns undefined when the caller hands a foreign pair_id', async () => {
    const { app, db, dbOps } = createTestApp();
    const { b } = await setupPair(app);

    await request(app)
      .post('/api/mailbox')
      .set('Authorization', `Bearer ${b.access_token}`)
      .send({ content: 'a letter for alice' });

    const refId = lastMailboxId(db);

    const row = dbOps.getMailboxMessageById(refId, 'FAKE_PAIR_ID');
    expect(row).toBeUndefined();
  });

  it('capsule lookup also refuses a foreign pair_id', async () => {
    const { app, dbOps } = createTestApp();
    const { a, b } = await setupPair(app);

    // Future capsule from A to B
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const created = await request(app)
      .post('/api/capsules')
      .set('Authorization', `Bearer ${a.access_token}`)
      .send({
        content: 'capsule body',
        unlock_date: future.slice(0, 10),
        unlock_at: future,
        visibility: 'partner',
      });
    expect(created.status).toBe(200);

    const userA = dbOps.getUser(a.user_id)!;
    const realPair = dbOps.couplesGetActivePairId(a.user_id, userA.partner_id!)!;
    const myCapsules = dbOps.getCapsules(realPair);
    const cap = myCapsules[0];
    expect(cap).toBeTruthy();

    expect(dbOps.getCapsuleById(cap.id, realPair)).toBeDefined();
    expect(dbOps.getCapsuleById(cap.id, 'FAKE_PAIR_ID')).toBeUndefined();

    // Bonus: ignore() the second arg — old test code used to call with just
    // (id). The new signature is required, so this guards the call sites
    // through TypeScript. No runtime assertion here.
  });

  it('inbox trash via API rejects ref_id from a foreign pair (404)', async () => {
    // Two independent couples. Couple-X has a letter; couple-Y tries to
    // trash it by id. The db-layer pair_id guard should make this
    // indistinguishable from "no such letter".
    const { app, db } = createTestApp();
    const { b: bx } = await setupPair(app);

    // Independent couple Y
    const ay = await registerUser(app, 'Yara');
    const by = await registerUser(app, 'Yuri');
    await pair(app, ay.access_token, by.user_id);

    // BX writes to AX (couple-X mailbox row)
    await request(app)
      .post('/api/mailbox')
      .set('Authorization', `Bearer ${bx.access_token}`)
      .send({ content: 'private to couple X' });

    const refId = (db.prepare('SELECT id FROM mailbox ORDER BY id DESC LIMIT 1').get() as { id: number }).id;

    // AY (different couple) tries to trash that id — must 404.
    const res = await request(app)
      .post('/api/inbox/trash')
      .set('Authorization', `Bearer ${ay.access_token}`)
      .send({ kind: 'mailbox', ref_id: refId });
    expect(res.status).toBe(404);
  });
});
