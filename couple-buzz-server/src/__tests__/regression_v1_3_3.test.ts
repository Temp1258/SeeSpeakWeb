/**
 * Regression tests for v1.3.3:
 *
 *   #1 — Inbox letter reader scrolls properly for long content. Root
 *        cause: ScrollView in EnvelopeOpenAnimation lacked a definite
 *        outer-height bound, so RN sized it to its content's intrinsic
 *        height; the parent card clipped at maxHeight but the ScrollView
 *        never perceived the overflow → no internal scroll. Fix pins
 *        contentScroll.maxHeight to LETTER_MAX_H − 200, and frees up
 *        envelopeWrap's pointer events (was "none", now "box-none") so
 *        the letter can be interacted with during the envelope reveal.
 *
 *   #2 — DELETE /api/stickies/:id returns 200 (was 500). Root cause:
 *        dbOps.deleteSticky passed 5 args to stmtGetStickyForCouple, but
 *        the post-v1.2.0 statement only takes 2 (id, pair_id) — the OR-
 *        clause across (user_id, partner_id) pairs was collapsed during
 *        the pair_id refactor and this call site was missed. Fix aligns
 *        the function's signature with the SQL and updates the only
 *        caller (DELETE route) to pass ctx.pairId.
 */

import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
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
  return { app, db, dbOps, mockPush };
}

async function registerUser(app: express.Express, name: string) {
  const res = await request(app)
    .post('/api/register')
    .send({ name, password: 'test1234', device_token: `${name}-token` });
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

async function postSticky(
  app: express.Express,
  token: string,
  content: string,
): Promise<number> {
  // Two-step lifecycle: create the temp row, then flip it to posted.
  await request(app)
    .post('/api/stickies/temp')
    .set('Authorization', `Bearer ${token}`)
    .send({});
  const res = await request(app)
    .post('/api/stickies/temp/post')
    .set('Authorization', `Bearer ${token}`)
    .send({ content });
  return res.body.sticky_id as number;
}

async function addCommentBlock(
  app: express.Express,
  token: string,
  stickyId: number,
  content: string,
): Promise<void> {
  await request(app)
    .post(`/api/stickies/${stickyId}/blocks/temp`)
    .set('Authorization', `Bearer ${token}`)
    .send({});
  await request(app)
    .post(`/api/stickies/${stickyId}/blocks/commit`)
    .set('Authorization', `Bearer ${token}`)
    .send({ content });
}

// ────────────────────────────────────────────────────────────────────
// #1 — EnvelopeOpenAnimation scroll fix (static source patterns)
// ────────────────────────────────────────────────────────────────────

describe('#1 — letter reader scrolls long content', () => {
  const ENV_SRC = fs.readFileSync(
    path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'couple-buzz-app',
      'src',
      'components',
      'EnvelopeOpenAnimation.tsx',
    ),
    'utf8',
  );

  it('contentScroll pins maxHeight to (LETTER_MAX_H − reserve) so internal scroll activates', () => {
    expect(ENV_SRC).toMatch(
      /contentScroll:\s*\{[\s\S]*?maxHeight:\s*LETTER_MAX_H\s*-\s*\d+/,
    );
  });

  it('contentScroll keeps flexShrink so short letters fit content without forcing the bound', () => {
    expect(ENV_SRC).toMatch(/contentScroll:\s*\{[\s\S]*?flexShrink:\s*1/);
  });

  it('envelopeWrap uses pointerEvents="box-none" (lets the inner letter ScrollView receive touches)', () => {
    expect(ENV_SRC).toMatch(/styles\.envelopeWrap[\s\S]*?pointerEvents="box-none"/);
  });

  it('envelopeWrap no longer uses pointerEvents="none" (sealed off all interaction)', () => {
    // Make sure the prior bug doesn't sneak back in via a stray "none".
    expect(ENV_SRC).not.toMatch(/styles\.envelopeWrap[\s\S]*?pointerEvents="none"/);
  });

  it('still uses a ScrollView around letter content (not Text-only, which never scrolls)', () => {
    expect(ENV_SRC).toMatch(/<ScrollView[\s\S]*?style=\{styles\.contentScroll\}/);
  });
});

// ────────────────────────────────────────────────────────────────────
// #2 — DELETE /api/stickies/:id no longer 500s
// ────────────────────────────────────────────────────────────────────

describe('#2 — DELETE /api/stickies/:id (撕下来) succeeds across cases', () => {
  it('tearing a fresh sticky with NO replies returns 200 and cleans up the row', async () => {
    const { app, db } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    const stickyId = await postSticky(app, alice.access_token, 'just me here');

    const res = await request(app)
      .delete(`/api/stickies/${stickyId}`)
      .set('Authorization', `Bearer ${alice.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const remaining = db
      .prepare('SELECT COUNT(*) as n FROM sticky_notes WHERE id = ?')
      .get(stickyId) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('tearing a sticky with replies also returns 200 and cascades through blocks + seen rows', async () => {
    const { app, db } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const stickyId = await postSticky(app, alice.access_token, 'first post');
    await addCommentBlock(app, bob.access_token, stickyId, 'partner reply 1');
    await addCommentBlock(app, alice.access_token, stickyId, 'self reply 2');
    // Bob marks the wall seen so a sticky_seen row exists for cascade.
    await request(app)
      .post(`/api/stickies/${stickyId}/seen`)
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({});

    const beforeBlocks = db
      .prepare('SELECT COUNT(*) as n FROM sticky_blocks WHERE sticky_id = ?')
      .get(stickyId) as { n: number };
    expect(beforeBlocks.n).toBeGreaterThanOrEqual(3);

    const res = await request(app)
      .delete(`/api/stickies/${stickyId}`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(200);

    // All three tables must be empty for this sticky after the cascade.
    const note = db
      .prepare('SELECT COUNT(*) as n FROM sticky_notes WHERE id = ?')
      .get(stickyId) as { n: number };
    const blocks = db
      .prepare('SELECT COUNT(*) as n FROM sticky_blocks WHERE sticky_id = ?')
      .get(stickyId) as { n: number };
    const seen = db
      .prepare('SELECT COUNT(*) as n FROM sticky_seen WHERE sticky_id = ?')
      .get(stickyId) as { n: number };
    expect(note.n).toBe(0);
    expect(blocks.n).toBe(0);
    expect(seen.n).toBe(0);
  });

  it('either partner can tear (not author-restricted)', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);
    const stickyId = await postSticky(app, alice.access_token, 'alice wrote this');

    // Bob tears Alice's post — explicitly allowed by spec for couple's wall.
    const res = await request(app)
      .delete(`/api/stickies/${stickyId}`)
      .set('Authorization', `Bearer ${bob.access_token}`);
    expect(res.status).toBe(200);
  });

  it('tearing a non-existent sticky returns 404 (no exception → no 500)', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    const res = await request(app)
      .delete('/api/stickies/999999')
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(res.status).toBe(404);
  });

  it('cross-pair tear fails with 404 (sticky belongs to a different couple)', async () => {
    const { app } = createTestApp();
    // Pair 1: Alice + Bob
    const { alice } = await registerPairedUsers(app);
    const aliceSticky = await postSticky(app, alice.access_token, 'private to A+B');

    // Pair 2: Carol + Dave — a separate couple
    const carol = await registerUser(app, 'Carol');
    const dave = await registerUser(app, 'Dave');
    await request(app)
      .post('/api/pair')
      .set('Authorization', `Bearer ${carol.access_token}`)
      .send({ partner_id: dave.user_id });

    const res = await request(app)
      .delete(`/api/stickies/${aliceSticky}`)
      .set('Authorization', `Bearer ${carol.access_token}`);
    expect(res.status).toBe(404);
  });

  it('unpaired user (no active pair_id) gets a 400 from requirePair, never reaches deleteSticky', async () => {
    const { app } = createTestApp();
    const loner = await registerUser(app, 'Loner');

    const res = await request(app)
      .delete('/api/stickies/1')
      .set('Authorization', `Bearer ${loner.access_token}`);
    // requirePair returns 400 "Not paired" before ever calling deleteSticky.
    expect(res.status).toBe(400);
  });

  it('double-tear is idempotent in effect: second DELETE returns 404, not 500', async () => {
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);
    const stickyId = await postSticky(app, alice.access_token, 'will be torn');

    const first = await request(app)
      .delete(`/api/stickies/${stickyId}`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(first.status).toBe(200);

    const second = await request(app)
      .delete(`/api/stickies/${stickyId}`)
      .set('Authorization', `Bearer ${alice.access_token}`);
    expect(second.status).toBe(404);
  });
});
