/**
 * Regression tests for the 4 HIGH bugs fixed in v1.2.13:
 *
 *   H1 — HistoryScreen used `new Date(action.created_at + 'Z')` (raw SQLite
 *        format with space, not ISO). Hermes parses this as Invalid Date in
 *        some configurations → wrong tz display + bad date grouping.
 *   H2 — App.tsx coldStartConsumedRef never reset across force-logout →
 *        re-login, so a notification arriving during the re-login window
 *        was silently dropped on the next `ready` transition.
 *   H3 — POST /api/daily-question/answer, /api/snaps, /api/daily-reaction
 *        only sent APNs pushes; a partner staring at 每日 tab had to leave
 *        and return to see the update. Server now also emits a `daily_update`
 *        socket event so cards can hot-reload without losing the in-app view.
 *   H4 — socket.ts client `connect_error` handler awaits a fresh ticket; if
 *        the global `socket` was replaced during the await (e.g. background→
 *        foreground triggered disconnectSocket+connectSocket), the handler
 *        applied the new ticket to the WRONG socket. Now captures
 *        `myInstance` at handler entry and bails after the await if the
 *        active socket has changed.
 *
 * H3 is testable end-to-end via supertest + a mocked `../socket` module
 * (so `emitToCouple` is a jest.fn we can inspect). H1, H2, H4 fix client
 * code that's not loaded into the server test harness — those are guarded
 * with source-pattern regression checks instead, brittle but enough to
 * fail loudly if someone reverts the fix without realizing.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createDatabase } from '../db';
import { createPublicRouter, createProtectedRouter, SendPushFn } from '../routes';
import { createAuthMiddleware } from '../auth';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing-only';

// Replace the real socket module with jest mocks so we can inspect
// emitToCouple calls. The other exports are stubbed to no-ops because
// routes.ts imports them at top-level — leaving them undefined would
// crash on first call.
jest.mock('../socket', () => ({
  emitToCouple: jest.fn(),
  isUserOnline: jest.fn().mockReturnValue(false),
  createWsTicket: jest.fn().mockReturnValue('mock-ticket'),
  disconnectCouple: jest.fn(),
  disconnectSession: jest.fn(),
  setupSocket: jest.fn(),
}));

// Pull the mocked emit so each test can assert on it. Re-imported per call
// so we always get the live jest.fn (its identity doesn't change but the
// call log does — explicit `mockClear` between tests keeps assertions
// scoped to the request under test).
import { emitToCouple } from '../socket';
const mockEmit = emitToCouple as jest.Mock;

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

beforeEach(() => {
  mockEmit.mockClear();
});

// ────────────────────────────────────────────────────────────────────
// H3 — daily_update socket emission
// ────────────────────────────────────────────────────────────────────

describe('H3 regression — daily_update socket emission', () => {
  it('POST /api/daily-question/answer emits daily_update with kind=answer to couple', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    const res = await request(app)
      .post('/api/daily-question/answer')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ answer: '我喜欢蓝色' });

    expect(res.status).toBe(200);

    const dailyEmits = mockEmit.mock.calls.filter(args => args[2] === 'daily_update');
    expect(dailyEmits.length).toBe(1);

    const [userIdA, userIdB, eventName, payload] = dailyEmits[0];
    // Routed to the couple room (both userIds passed to emitToCouple).
    expect(new Set([userIdA, userIdB])).toEqual(new Set([alice.user_id, bob.user_id]));
    expect(eventName).toBe('daily_update');
    expect(payload).toMatchObject({ from: alice.user_id, kind: 'answer' });
  });

  it('POST /api/daily-reaction emits daily_update with kind=reaction + target', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Both must answer before reactions are allowed.
    await request(app)
      .post('/api/daily-question/answer')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ answer: 'a' });
    await request(app)
      .post('/api/daily-question/answer')
      .set('Authorization', `Bearer ${bob.access_token}`)
      .send({ answer: 'b' });

    mockEmit.mockClear();

    const res = await request(app)
      .post('/api/daily-reaction')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ type: 'question', reaction: 'up' });

    expect(res.status).toBe(200);

    const dailyEmits = mockEmit.mock.calls.filter(args => args[2] === 'daily_update');
    expect(dailyEmits.length).toBe(1);
    const [, , , payload] = dailyEmits[0];
    expect(payload).toMatchObject({
      from: alice.user_id,
      kind: 'reaction',
      target: 'question',
    });
  });

  it('POST /api/snaps emits daily_update with kind=snap', async () => {
    const { app } = createTestApp();
    const { alice, bob } = await registerPairedUsers(app);

    // Minimal valid JPEG: 2-byte SOI + 2-byte EOI. multer's fileFilter only
    // checks MIME prefix, not magic bytes, so this is enough to pass.
    const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    const res = await request(app)
      .post('/api/snaps')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .attach('photo', tinyJpeg, { filename: 'snap.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const dailyEmits = mockEmit.mock.calls.filter(args => args[2] === 'daily_update');
    expect(dailyEmits.length).toBe(1);
    const [, , , payload] = dailyEmits[0];
    expect(payload).toMatchObject({ from: alice.user_id, kind: 'snap' });

    // Best-effort cleanup — multer wrote to data/snaps/{userId}/{date}.jpg.
    // Failing here doesn't fail the test (the assertion above is what
    // matters); the directory is gitignored anyway.
    try {
      const dir = path.join(__dirname, '..', '..', 'data', 'snaps', alice.user_id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    // Also wipe stray tmp files that multer left for the bob row (none here,
    // but keep the convention for future tests).
    void bob;
  });

  it('routes that do NOT involve 每日 tab still do NOT emit daily_update', async () => {
    // Sanity: the 4 daily endpoints emit daily_update, but unrelated routes
    // (action, sticky, mailbox) must not — otherwise we'd be over-broadcasting
    // and clients would reload the daily tab on every emoji click.
    const { app } = createTestApp();
    const { alice } = await registerPairedUsers(app);

    await request(app)
      .post('/api/action')
      .set('Authorization', `Bearer ${alice.access_token}`)
      .send({ action_type: 'kiss' });

    const dailyEmits = mockEmit.mock.calls.filter(args => args[2] === 'daily_update');
    expect(dailyEmits.length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// H1, H2, H4 — client source-pattern regression checks
//
// These don't run the actual client code (no RN harness in the server
// test suite), but they do guard against the specific code shape that
// caused the bug from being reintroduced. Each check pairs:
//   • a "must NOT contain" assertion for the buggy pattern
//   • a "must contain" assertion for the fix's marker
// so a partial revert (deleting one but not the other) still trips.
// ────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'couple-buzz-app');

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(APP_ROOT, relPath), 'utf8');
}

describe('H1 regression — HistoryScreen uses normalizeIso for SQLite timestamps', () => {
  let src: string;
  beforeAll(() => {
    src = readSource('src/screens/HistoryScreen.tsx');
  });

  it('does NOT use raw `+ \'Z\'` parsing (the buggy pattern)', () => {
    // Allow the literal "+ 'Z'" only in comments, not in code. We strip
    // line comments before checking — block comments mentioning 'Z' would
    // need adjustment but currently none exist.
    const codeOnly = src
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');
    expect(codeOnly).not.toMatch(/created_at\s*\+\s*['"]Z['"]/);
    expect(codeOnly).not.toMatch(/dateStr\s*\+\s*['"]Z['"]/);
  });

  it('imports normalizeIso from utils/inboxUnread', () => {
    expect(src).toMatch(/import\s*\{\s*normalizeIso\s*\}\s*from\s*['"]\.\.\/utils\/inboxUnread['"]/);
  });

  it('calls normalizeIso when building Dates from server timestamps', () => {
    // At least one usage in formatTimeInZone + groupByDate.
    const usages = src.match(/new Date\(\s*normalizeIso\(/g) || [];
    expect(usages.length).toBeGreaterThanOrEqual(2);
  });
});

describe('H2 regression — coldStartConsumedRef resets on leaving ready', () => {
  let src: string;
  beforeAll(() => {
    src = readSource('App.tsx');
  });

  it('resets the ref to false when appState !== "ready"', () => {
    // The fix sets the ref back to false inside the same effect, so a
    // subsequent `ready` transition (force-logout → re-login same process)
    // can consume a fresh notification response. Match the assignment loosely
    // to allow whitespace / comment variations.
    expect(src).toMatch(/coldStartConsumedRef\.current\s*=\s*false/);
  });

  it('still has the consumption guard so we do not navigate twice on the same notification', () => {
    // The guard line `if (coldStartConsumedRef.current) return;` (or a
    // semantic equivalent like `if (!ref.current) ... = true`) must remain.
    expect(src).toMatch(/coldStartConsumedRef\.current\s*=\s*true/);
  });
});

describe('H4 regression — socket connect_error captures own instance before await', () => {
  let src: string;
  beforeAll(() => {
    src = readSource('src/services/socket.ts');
  });

  it('captures the socket instance into a local before awaiting getWsTicket', () => {
    // We don't pin the variable name (might be myInstance, captured,
    // mySocket...) — just require that there's some local-binding
    // assignment from `socket` ahead of the await, AND a comparison after
    // the await that bails when the active socket has changed.
    const errHandler = src.match(/socket\.on\(\s*['"]connect_error['"][\s\S]*?\}\);/);
    expect(errHandler).not.toBeNull();
    const handlerBody = errHandler![0];

    // Local binding from `socket` (e.g. `const myInstance = socket`).
    expect(handlerBody).toMatch(/const\s+\w+\s*=\s*socket/);

    // After the await, an identity check against that local. Permissive
    // regex: any `socket === <ident>` or `<ident> === socket` comparison.
    expect(handlerBody).toMatch(/(socket\s*===\s*\w+|\w+\s*===\s*socket)/);
  });
});
