import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto, { randomInt } from 'crypto';
import { DbOps } from './db';
import { QUESTIONS } from './questions';
import { createWsTicket, disconnectCouple, disconnectSession, emitToCouple, isUserOnline } from './socket';
import { pushToUser } from './push';
import type { SendPushFn } from './push';
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  getRefreshTokenExpiresAt,
  createAuthMiddleware,
  hashPassword,
  verifyPassword,
  generateUserId,
  signImagePath,
} from './auth';

// Re-export for back-compat with consumers (e.g. tests) that imported the
// type from routes. The canonical home is push.ts now.
export type { SendPushFn };

// Length limits, also enforced at the API edge so a misbehaving client can't
// bypass the UI's maxLength. `name` shows up in every push body — letting it
// grow unbounded would blow APNs' 4KB payload cap and silently kill pushes.
const NAME_MAX = 20;
const REMARK_MAX = 30;
const DATE_TITLE_MAX = 50;

// Whitelist of action types a client is allowed to send via POST /action and
// POST /reaction. Anything else is rejected to keep the actions table clean
// and prevent a malicious client from polluting it with arbitrary strings.
const VALID_ACTIONS: ReadonlySet<string> = new Set([
  'miss', 'finger_heart', 'love', 'kiss', 'poop', 'pat',
  'shy', 'rose', 'hug', 'pick_nose',
  'eat', 'angry_silent', 'angry_talk', 'hungry', 'sleepy',
  'where_r_u', 'what_doing', 'sleep', 'play', 'clean',
  'cry', 'wuwu', 'sad', 'clown', 'haha', 'hehe', 'work',
  'slap', 'ping',
  'call_wife', 'call_husband', 'call_baby',
  'gym', 'milk_tea', 'drink',
  'show_off', 'smug', 'praise_me', 'praise_you',
  'phone', 'tablet', 'lazy',
  'red_note', 'board_game', 'party', 'driving', 'audiobook', 'riding', 'meeting',
  'weather_sunny', 'weather_cloudy', 'weather_rain', 'weather_thunder', 'weather_snow',
]);

// Timezone helpers
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Strict YYYY-MM-DD with calendar validation. Rejects "2024-02-31" even
// though that string matches the regex, by round-tripping through Date.
function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function safeTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'Asia/Shanghai';
}

function getLocalDate(timezone: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: safeTimezone(timezone) });
}

// Daily-question / daily-snap session key: rolls at 7am Beijing time.
// Anything before 7am BJT belongs to the prior session date.
// Implemented as a fixed UTC+1 frame (BJT 7am = UTC 23:00 prior day, so
// shifting now by +1h aligns the frame's midnight with BJT 7am).
function getBjt7amDate(): string {
  const shifted = new Date(Date.now() + 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function getLocalHour(timezone: string): number {
  const h = parseInt(new Date().toLocaleString('en-US', { timeZone: safeTimezone(timezone), hour: 'numeric', hour12: false }), 10);
  return h === 24 ? 0 : h;
}

// Distance from "now" until midnight of `targetDateStr` in `timezone`,
// formatted like "3天5小时". Falls back to "0小时" if the target is past.
function formatDayHourCountdown(targetDateStr: string, timezone: string): string {
  const tz = safeTimezone(timezone);
  const now = new Date();

  // Midnight of target date in the target timezone, expressed as a UTC instant.
  // Build via en-CA locale to compute the offset.
  const offsetMin = (() => {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'shortOffset',
      });
      const parts = fmt.formatToParts(now);
      const off = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT+0';
      const m = off.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
      if (!m) return 0;
      const sign = m[1] === '+' ? 1 : -1;
      return sign * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));
    } catch {
      return 0;
    }
  })();

  const [y, mo, d] = targetDateStr.split('-').map(Number);
  // 00:00 local time = 00:00 UTC minus offset
  const targetUtcMs = Date.UTC(y, mo - 1, d, 0, 0, 0) - offsetMin * 60 * 1000;
  const diffMs = targetUtcMs - now.getTime();
  if (diffMs <= 0) return '0小时';

  const totalHours = Math.floor(diffMs / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days === 0) return `${hours}小时`;
  return `${days}天${hours}小时`;
}

function getYesterdayDate(todayStr: string): string {
  const [y, m, d] = todayStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

// Compute the offset (minutes, signed) such that
//   localTime (in tz) = utcTime + offset*60_000
// Two-pass to handle DST: format the candidate UTC date in tz, parse parts
// back as UTC, refine. Mirrors the client-side helper.
function tzOffsetMinutes(date: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const obj: Record<string, string> = {};
    for (const p of parts) obj[p.type] = p.value;
    const hour = obj.hour === '24' ? 0 : Number(obj.hour);
    const asUtc = Date.UTC(
      Number(obj.year), Number(obj.month) - 1, Number(obj.day),
      hour, Number(obj.minute), Number(obj.second || 0),
    );
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

// Convert "local 00:00 of YYYY-MM-DD in tz" to a UTC ISO instant. Used by
// daily / weekly aggregations that need to slice on the user's local-day
// boundary instead of UTC's.
function localDateStartToUtcIso(localDate: string, tz: string): string {
  const safeTz = safeTimezone(tz);
  const [y, m, d] = localDate.split('-').map(Number);
  const naiveMs = Date.UTC(y, m - 1, d, 0, 0);
  const offset1 = tzOffsetMinutes(new Date(naiveMs), safeTz);
  let utcMs = naiveMs - offset1 * 60_000;
  const offset2 = tzOffsetMinutes(new Date(utcMs), safeTz);
  if (offset2 !== offset1) utcMs = naiveMs - offset2 * 60_000;
  return new Date(utcMs).toISOString();
}

// Same as above but advances the local date by `days` first.
function localDateOffsetToUtcIso(localDate: string, tz: string, days: number): string {
  const [y, m, d] = localDate.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d));
  next.setUTCDate(next.getUTCDate() + days);
  return localDateStartToUtcIso(next.toISOString().slice(0, 10), tz);
}

// Used by weekly report. Returns the YYYY-MM-DD of this week's Monday in
// the user's timezone — so a NY user gets their Monday-Sunday week, not
// the UTC Monday-Sunday week (which starts ~Sunday-evening NY local).
function getCurrentWeekMonday(timezone: string): string {
  const tz = safeTimezone(timezone);
  // Today's calendar date as the user sees it in their tz.
  const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const [y, m, d] = todayLocal.split('-').map(Number);
  // Build a UTC instant at midnight of (y,m,d) — its UTC weekday equals the
  // user's local weekday because we used the local y/m/d. 0=Sun..6=Sat.
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const diffToMonday = (dow === 0 ? -6 : 1) - dow;
  const monday = new Date(Date.UTC(y, m - 1, d));
  monday.setUTCDate(monday.getUTCDate() + diffToMonday);
  return monday.toISOString().slice(0, 10);
}

// Mailbox helpers — twice-daily session cycle.
// AM session: 0:00-11:59 UTC (= 8am-7:59pm BJT) → reveals at 12:00 UTC (= 8pm BJT)
// PM session: 12:00-23:59 UTC (= 8pm BJT to 7:59am BJT next day) → reveals next 0:00 UTC (= 8am BJT)
function getCurrentSessionKey(): string {
  const now = new Date();
  const utcDate = now.toISOString().slice(0, 10);
  const utcHour = now.getUTCHours();
  return utcHour < 12 ? `${utcDate}-AM` : `${utcDate}-PM`;
}

function getRevealTime(sessionKey: string): Date {
  const date = sessionKey.slice(0, 10);
  const phase = sessionKey.slice(11);
  if (phase === 'AM') {
    return new Date(`${date}T12:00:00Z`);
  }
  // PM: reveal next day 0:00 UTC
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}


// Generate a random 4-digit pair code (CSPRNG, not Math.random)
export function generatePairCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[randomInt(chars.length)];
  }
  return code;
}

function parseId(value: string): number | null {
  const n = parseInt(value, 10);
  return isNaN(n) ? null : n;
}

function parseDeviceInfo(body: { device?: unknown }): import('./db').DeviceInfo | undefined {
  const d = body.device;
  if (!d || typeof d !== 'object') return undefined;
  // Per-field length cap so a hostile / glitchy client can't blow up the
  // device-list rendering with a 100KB string. 80 chars is enough for
  // "Steve's iPhone 15 Pro Max".
  const cap = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    return trimmed ? trimmed.slice(0, 80) : null;
  };
  const obj = d as Record<string, unknown>;
  return {
    name: cap(obj.name),
    model: cap(obj.model),
    os: cap(obj.os),
    app_version: cap(obj.app_version),
  };
}

// iOS 16+ without the user-assigned-device-name entitlement returns
// the device model from UIDevice.name, so the client can only send
// these defaults. When we see one of these on /api/login, we treat it
// as "no opinion from the client" and inherit the prior name the user
// set for this OS — otherwise re-login would silently reset a
// renamed device back to "iPhone".
const DEFAULT_DEVICE_NAMES = new Set(['iPhone', 'iPad', 'Mac', 'Android Phone', 'Device']);

function applyDeviceNameInheritance(
  dbOps: DbOps,
  userId: string,
  deviceInfo: import('./db').DeviceInfo | undefined,
): import('./db').DeviceInfo | undefined {
  if (!deviceInfo) return deviceInfo;
  const incoming = deviceInfo.name?.trim() ?? '';
  // Respect a non-default name from the client — if the user later
  // adds the entitlement and Constants.deviceName starts returning
  // their real "Steve 的 iPhone", we don't want to silently overwrite
  // it with a stale rename from history.
  if (incoming && !DEFAULT_DEVICE_NAMES.has(incoming)) return deviceInfo;
  const inherited = dbOps.inheritDeviceNameForOs(userId, deviceInfo.os ?? null);
  if (!inherited || inherited === incoming) return deviceInfo;
  return { ...deviceInfo, name: inherited };
}

function issueTokens(
  dbOps: DbOps,
  userId: string,
  tokenVersion: number,
  deviceInfo?: import('./db').DeviceInfo,
  isPrimary?: boolean,
) {
  const sessionId = crypto.randomUUID();
  const refreshToken = generateRefreshToken();
  const expiresAt = getRefreshTokenExpiresAt();

  dbOps.insertRefreshToken(
    userId,
    hashToken(refreshToken),
    expiresAt,
    sessionId,
    deviceInfo,
    isPrimary,
  );

  const accessToken = generateAccessToken(userId, tokenVersion, sessionId);
  return { access_token: accessToken, refresh_token: refreshToken, session_id: sessionId };
}

export function createPublicRouter(dbOps: DbOps): Router {
  const router = Router();

  // POST /api/register — create account with ID + password
  router.post('/register', (req: Request, res: Response) => {
    const { name, password, device_token, timezone } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }
    if (name.trim().length === 0 || name.trim().length > NAME_MAX) {
      return res.status(400).json({ error: `name must be 1-${NAME_MAX} characters` });
    }
    if (!password || typeof password !== 'string' || password.length < 4) {
      return res.status(400).json({ error: 'password is required (min 4 chars)' });
    }

    let userId = generateUserId();
    while (dbOps.getUser(userId)) {
      userId = generateUserId();
    }

    const passwordHash = hashPassword(password);
    const pairCode = userId; // ID itself is the connection code

    const userTz = (timezone && isValidTimezone(timezone)) ? timezone : 'Asia/Shanghai';
    dbOps.createUser(userId, name.trim(), passwordHash, pairCode, userTz);

    const user = dbOps.getUser(userId)!;
    // Brand-new account: this is the only device → claim primary so the
    // device-list always has someone able to manage other devices later.
    const deviceInfo = parseDeviceInfo(req.body);
    const { access_token, refresh_token, session_id } = issueTokens(
      dbOps, userId, user.token_version, deviceInfo, true,
    );

    if (device_token) {
      dbOps.setDeviceToken(userId, device_token);
      dbOps.attachDeviceTokenToSession(device_token, session_id);
    }

    res.json({ user_id: userId, access_token, refresh_token });
  });

  // POST /api/login — login with ID + password
  router.post('/login', (req: Request, res: Response) => {
    const { user_id, password, device_token } = req.body;

    if (!user_id || !password) {
      return res.status(400).json({ error: 'user_id and password are required' });
    }
    if (typeof user_id !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'user_id and password must be strings' });
    }

    const user = dbOps.getUser(user_id.toUpperCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid ID or password' });
    }

    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid ID or password' });
    }

    // Login on a new device: mark primary only if the user has no
    // primary right now (e.g. they only had legacy/sidless tokens, or
    // their previous primary was force-revoked). Otherwise leave the
    // existing primary alone — the user can promote this device manually
    // from Settings.
    const hasPrimary = dbOps
      .listSessionsForUser(user.id, '')
      .some((s) => s.is_primary);
    const deviceInfo = applyDeviceNameInheritance(
      dbOps,
      user.id,
      parseDeviceInfo(req.body),
    );
    const { access_token, refresh_token, session_id } = issueTokens(
      dbOps, user.id, user.token_version, deviceInfo, !hasPrimary,
    );

    if (device_token) {
      // Bind this APNs token to the just-issued session — Step 3
      // guarantees: revoking a session also drops its push registration.
      dbOps.setDeviceToken(user.id, device_token);
      dbOps.attachDeviceTokenToSession(device_token, session_id);
    }

    const partnerName = user.partner_id ? dbOps.getUser(user.partner_id)?.name ?? null : null;

    // Include `name` so the client can persist the user's own nickname after
    // a fresh login. Without it, storage.getUserName() returns null until the
    // user navigates to Settings and saves — every screen that displays the
    // user's name (MailboxCard, InboxScreen, TimeCapsuleCard, HistoryScreen)
    // would fall back to "我" in the meantime.
    res.json({ user_id: user.id, name: user.name, partner_name: partnerName, access_token, refresh_token });
  });

  // POST /api/auth/refresh — public, uses refresh token
  router.post('/auth/refresh', (req: Request, res: Response) => {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({ error: 'refresh_token is required' });
    }

    const tokenHash = hashToken(refresh_token);
    const stored = dbOps.getRefreshToken(tokenHash);

    if (!stored) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Check expiry
    if (new Date(stored.expires_at) < new Date()) {
      dbOps.deleteRefreshToken(tokenHash);
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    // Grace window: if this token has already been rotated, accept the
    // retry only within ~10s (covers a network failure mid-rotate where
    // the client never received the new pair). Past the grace window, an
    // already-rotated token is effectively a leaked / stolen credential
    // and is rejected.
    if (stored.superseded_at) {
      const supersededMs = new Date(stored.superseded_at + 'Z').getTime();
      if (Number.isNaN(supersededMs)) {
        // Defensive: malformed timestamp shouldn't lock the user out.
      } else if (Date.now() - supersededMs > 10_000) {
        return res.status(401).json({ error: 'Refresh token already used' });
      }
    }

    // Bug-13 fix: a force-revoked session must NOT be revivable via its
    // still-stored refresh token. Reject before issuing a new pair.
    if (stored.revoked) {
      return res.status(401).json({ error: 'Session revoked', code: 'session_revoked' });
    }

    const user = dbOps.getUser(stored.user_id);
    if (!user) {
      dbOps.deleteRefreshToken(tokenHash);
      return res.status(401).json({ error: 'User not found' });
    }

    // Issue a new pair on the SAME session_id (Bug-1 fix: rotate must
    // preserve session continuity, otherwise every refresh would create
    // a new "phantom session" in the device list). Old hash is marked
    // superseded but kept around for the 10s grace window so a network-
    // glitch retry can repeat this path.
    const sessionId = stored.session_id || crypto.randomUUID();
    const refreshToken = generateRefreshToken();
    const expiresAt = getRefreshTokenExpiresAt();
    dbOps.rotateRefreshToken(tokenHash, user.id, hashToken(refreshToken), expiresAt, sessionId);
    dbOps.touchSessionLastActive(sessionId);
    // Opportunistic cleanup of expired / grace-elapsed rows. Cheap because
    // refresh_tokens stays small; no separate cron needed.
    dbOps.pruneRefreshTokens();

    const accessToken = generateAccessToken(user.id, user.token_version, sessionId);
    res.json({ access_token: accessToken, refresh_token: refreshToken });
  });

  return router;
}

export function createProtectedRouter(dbOps: DbOps, pushFn: SendPushFn): Router {
  const router = Router();

  // GET /api/status — check if paired
  router.get('/status', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.partner_id) {
      const partner = dbOps.getUser(user.partner_id);
      const streak = dbOps.getStreak(userId, user.partner_id);
      // pair_id surfaces the relationship's stable handle to clients so
      // Settings can show it ("你们的关系编号 KMRPQT4729"). Will be null
      // only in the brief race window between pairUsers and couples row
      // creation — Phase B routes ensure both happen in the same handler.
      const pair_id = dbOps.couplesGetActivePairId(userId, user.partner_id);
      return res.json({
        paired: true,
        partner_id: user.partner_id,
        partner_name: partner?.name ?? null,
        pair_id,
        name: user.name,
        timezone: user.timezone,
        partner_timezone: user.partner_timezone,
        partner_remark: user.partner_remark,
        streak,
      });
    }

    res.json({ paired: false, name: user.name, timezone: user.timezone, partner_timezone: user.partner_timezone, partner_remark: user.partner_remark, streak: 0 });
  });

  // PUT /api/profile — update name and/or timezone
  router.put('/profile', (req: Request, res: Response) => {
    const userId = req.userId!;
    const { name, timezone, partner_timezone, partner_remark } = req.body;

    const user = dbOps.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (name !== undefined) {
      if (typeof name !== 'string') return res.status(400).json({ error: 'name must be a string' });
      if (name.trim().length > NAME_MAX) return res.status(400).json({ error: `name max ${NAME_MAX} characters` });
    }
    if (partner_remark !== undefined) {
      if (typeof partner_remark !== 'string') return res.status(400).json({ error: 'partner_remark must be a string' });
      if (partner_remark.length > REMARK_MAX) return res.status(400).json({ error: `partner_remark max ${REMARK_MAX} characters` });
    }

    const newName = (name && typeof name === 'string' && name.trim()) ? name.trim() : user.name;
    const newTimezone = (timezone && typeof timezone === 'string' && isValidTimezone(timezone)) ? timezone : user.timezone;
    const newPartnerTz = (partner_timezone && typeof partner_timezone === 'string' && isValidTimezone(partner_timezone)) ? partner_timezone : user.partner_timezone;
    const newRemark = (typeof partner_remark === 'string') ? partner_remark : user.partner_remark;

    dbOps.updateProfile(userId, newName, newTimezone, newPartnerTz, newRemark);
    res.json({ success: true, name: newName, timezone: newTimezone, partner_timezone: newPartnerTz, partner_remark: newRemark });
  });

  // POST /api/pair — connect with partner using their user ID
  router.post('/pair', (req: Request, res: Response) => {
    const userId = req.userId!;
    const { partner_id: partnerId } = req.body;

    if (!partnerId) {
      return res.status(400).json({ error: 'partner_id is required' });
    }
    if (typeof partnerId !== 'string') {
      return res.status(400).json({ error: 'partner_id must be a string' });
    }

    const user = dbOps.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.partner_id) {
      return res.status(400).json({ error: 'Already paired' });
    }

    const partner = dbOps.getUser(partnerId.toUpperCase());
    if (!partner) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (partner.id === userId) {
      return res.status(400).json({ error: 'Cannot pair with yourself' });
    }

    // Reject pairing with someone who's already paired — otherwise we'd silently
    // overwrite their existing partnership and orphan the original spouse's pointer.
    if (partner.partner_id) {
      return res.status(400).json({ error: 'Partner is already paired with someone else' });
    }

    // Single atomic combo: claim/revive pair_id + flip partner_id
    // pointers. If the same two users had a previous pairing within the
    // 90-day grace window, the historical data resurfaces (revived).
    // Past TTL → fresh pair_id.
    const { pair_id, revived } = dbOps.pairCouple(userId, partner.id);

    res.json({ success: true, partner_name: partner.name, pair_id, revived });
  });

  // POST /api/action
  router.post('/action', async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { action_type, timezone } = req.body;

    if (!action_type || typeof action_type !== 'string' || !VALID_ACTIONS.has(action_type)) {
      return res.status(400).json({ error: 'Invalid action_type' });
    }

    const user = dbOps.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.partner_id) {
      return res.status(400).json({ error: 'Not paired yet' });
    }

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    dbOps.addAction(userId, pairId, action_type, timezone || user.timezone, user.name);

    const partner = dbOps.getUser(user.partner_id);
    // Skip the APNs push if the partner is foregrounded — the socket
    // 'action_new' below already drives the haptic + red dot, so a banner
    // would be redundant noise. Push still fires when partner is offline.
    if (partner && !isUserOnline(partner.id)) {
      const unread = dbOps.getUnreadActionCount(partner.id, userId);
      await pushToUser(dbOps, pushFn, partner.id, action_type, user.name, undefined, unread);
    }
    emitToCouple(userId, user.partner_id, 'action_new', { from: userId, action_type });

    res.json({ success: true });
  });

  // POST /api/reaction
  router.post('/reaction', async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { action_id, action_type } = req.body;

    if (!action_id || !action_type || typeof action_type !== 'string') {
      return res.status(400).json({ error: 'action_id and action_type are required' });
    }
    if (!VALID_ACTIONS.has(action_type)) {
      return res.status(400).json({ error: 'Invalid action_type' });
    }

    const actionId = typeof action_id === 'number' ? action_id : parseInt(action_id, 10);
    if (isNaN(actionId)) return res.status(400).json({ error: 'action_id must be a valid number' });

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const targetAction = dbOps.getAction(actionId);
    if (!targetAction) return res.status(404).json({ error: 'Action not found' });
    if (targetAction.user_id !== user.partner_id) return res.status(400).json({ error: 'Cannot react to this action' });
    if (targetAction.reply_to !== null) return res.status(400).json({ error: 'Cannot react to a reaction' });

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    const reactionId = dbOps.addReaction(userId, pairId, action_type, user.timezone, user.name, actionId);

    const partner = dbOps.getUser(user.partner_id);
    // Same online-skip rationale as /api/actions above.
    if (partner && !isUserOnline(partner.id)) {
      const unread = dbOps.getUnreadActionCount(partner.id, userId);
      await pushToUser(dbOps, pushFn, partner.id, 'reaction', user.name, undefined, unread);
    }
    emitToCouple(userId, user.partner_id, 'action_new', { from: userId, action_type, reply_to: actionId });

    res.json({ success: true, reaction_id: reactionId });
  });

  // GET /api/history
  router.get('/history', (req: Request, res: Response) => {
    const userId = req.userId!;
    const limit = parseInt(req.query.limit as string, 10) || 50;

    const user = dbOps.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Solo users (no current partner) see an empty history — past
    // relationships' actions are no longer mixed in by default.
    if (!user.partner_id) {
      return res.json({ actions: [], reactions: {}, last_read_action_id: user.last_read_action_id });
    }
    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) {
      return res.json({ actions: [], reactions: {}, last_read_action_id: user.last_read_action_id });
    }
    const actions = dbOps.getHistory(pairId, Math.min(limit, 200));

    // Group reactions by parent action id. Pass the actions' ids so
    // the DB only fetches reactions tied to this page — older pairs
    // used to lose old reactions to a hard LIMIT 500 cutoff.
    const allReactions = dbOps.getHistoryReactions(pairId, actions.map((a) => a.id));
    const reactions: Record<number, typeof allReactions> = {};
    for (const r of allReactions) {
      if (r.reply_to !== null) {
        if (!reactions[r.reply_to]) reactions[r.reply_to] = [];
        reactions[r.reply_to].push(r);
      }
    }

    // Send the read pointer alongside actions so the client can render the
    // unread/read divider exactly at where the user left off last session.
    // Read here is non-mutating — POST /api/mark-read advances it.
    res.json({ actions, reactions, last_read_action_id: user.last_read_action_id });
  });

  // POST /api/mark-read — client tells the server it has seen up to this
  // action id. Server only accepts ids that monotonically advance, so a stale
  // request can't undo a fresh "all read" mark.
  router.post('/mark-read', (req: Request, res: Response) => {
    const userId = req.userId!;
    const { last_id } = req.body;

    const id = typeof last_id === 'number' ? last_id : parseInt(last_id, 10);
    if (!Number.isFinite(id) || id < 0) {
      return res.status(400).json({ error: 'last_id must be a non-negative integer' });
    }

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Clamp to the highest action id the partner has actually sent. Without
    // this a misbehaving client could ship Number.MAX_SAFE_INTEGER and pin
    // the read pointer above any future action — silently muting badges.
    const latest = user.partner_id ? dbOps.getLatestPartnerActionId(userId, user.partner_id) : 0;
    const clamped = Math.min(id, latest);
    dbOps.setLastReadActionId(userId, clamped);
    const unread = user.partner_id ? dbOps.getUnreadActionCount(userId, user.partner_id) : 0;
    res.json({ success: true, unread });
  });

  // PUT /api/device-token
  router.put('/device-token', (req: Request, res: Response) => {
    const userId = req.userId!;
    const { device_token } = req.body;

    if (!device_token || typeof device_token !== 'string') {
      return res.status(400).json({ error: 'device_token is required' });
    }
    if (device_token.length > 200) {
      return res.status(400).json({ error: 'device_token too long' });
    }

    const user = dbOps.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    dbOps.setDeviceToken(userId, device_token);
    res.json({ success: true });
  });

  // POST /api/unpair
  router.post('/unpair', async (req: Request, res: Response) => {
    const userId = req.userId!;

    const user = dbOps.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.partner_id) {
      return res.status(400).json({ error: 'Not paired' });
    }

    const partner = dbOps.getUser(user.partner_id);
    const partnerIdSnapshot = user.partner_id;

    // Atomic: mark couples row ended (starts 90-day TTL) + clear both
    // users' partner_id pointers in one transaction. Closes the window
    // where a server kill mid-handler could leave them desynced.
    dbOps.unpairCouple(userId, partnerIdSnapshot);

    // Drop any live socket connections in the couple's room. Without this,
    // either side could keep receiving the other's real-time events
    // (touch / sticky_update / presence) until the natural disconnect.
    disconnectCouple(userId, partnerIdSnapshot);

    // Generate new pair codes for both
    let newPairCode = generatePairCode();
    while (dbOps.getUserByPairCode(newPairCode)) {
      newPairCode = generatePairCode();
    }
    dbOps.updatePairCode(userId, newPairCode);

    let partnerPairCode = generatePairCode();
    while (dbOps.getUserByPairCode(partnerPairCode)) {
      partnerPairCode = generatePairCode();
    }
    if (partner) {
      dbOps.updatePairCode(partner.id, partnerPairCode);
    }

    // Notify partner via push
    if (partner) {
      await pushToUser(dbOps, pushFn, partner.id, 'unpair', user.name);
    }

    res.json({ success: true, new_pair_code: newPairCode });
  });

  // GET /api/dates
  router.get('/dates', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.json({ dates: [], nearest: null });

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.json({ dates: [], pinned: null });
    const dates = dbOps.getImportantDates(pairId);

    // Compute pinned date countdown (only pinned date shows on homepage).
    // For non-recurring dates, the date may be in the past (e.g. "在一起的
    // 日子") and we want to show "已经 N 天啦". `days_diff` carries sign
    // (- = past, 0 = today, + = upcoming); `days_away` is its absolute value
    // for backward compatibility.
    const today = new Date().toISOString().slice(0, 10);
    let pinned: { title: string; date: string; days_away: number; days_diff: number } | null = null;

    const pinnedDate = dates.find(d => d.pinned);
    if (pinnedDate) {
      let targetDate = pinnedDate.date;
      if (pinnedDate.recurring) {
        // Recurring dates always project to the next occurrence (today or future)
        const thisYear = new Date().getFullYear();
        const mmdd = pinnedDate.date.slice(5);
        targetDate = `${thisYear}-${mmdd}`;
        if (targetDate < today) {
          targetDate = `${thisYear + 1}-${mmdd}`;
        }
      }
      const daysDiff = Math.round((new Date(targetDate).getTime() - new Date(today).getTime()) / 86400000);
      pinned = {
        title: pinnedDate.title,
        date: targetDate,
        days_away: Math.abs(daysDiff),
        days_diff: daysDiff,
      };
    }

    res.json({ dates, pinned });
  });

  // POST /api/dates
  router.post('/dates', async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { title, date, recurring } = req.body;

    if (!title || typeof title !== 'string' || !date || typeof date !== 'string') {
      return res.status(400).json({ error: 'title and date are required' });
    }
    if (title.length > DATE_TITLE_MAX) return res.status(400).json({ error: `title max ${DATE_TITLE_MAX} characters` });
    if (!isValidDateString(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    const existing = dbOps.getImportantDates(pairId);
    if (existing.length >= 20) return res.status(400).json({ error: 'Maximum 20 dates' });

    const created = dbOps.createImportantDate(userId, user.partner_id, pairId, title.trim(), date, !!recurring);

    const partner = dbOps.getUser(user.partner_id);
    if (partner) {
      await pushToUser(dbOps, pushFn, partner.id, 'date_new', user.name);
    }

    res.json({ date: created });
  });

  // PUT /api/dates/:id
  router.put('/dates/:id', (req: Request, res: Response) => {
    const userId = req.userId!;
    const id = parseId(req.params.id as string);
    if (id === null) return res.status(400).json({ error: 'Invalid ID' });
    const { title, date, recurring } = req.body;

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    if (!title || typeof title !== 'string' || !date || typeof date !== 'string') {
      return res.status(400).json({ error: 'title and date are required' });
    }
    if (title.length > DATE_TITLE_MAX) return res.status(400).json({ error: `title max ${DATE_TITLE_MAX} characters` });
    if (!isValidDateString(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    const updated = dbOps.updateImportantDate(id, title.trim(), date, !!recurring, pairId);
    if (!updated) return res.status(404).json({ error: 'Date not found' });

    res.json({ success: true });
  });

  // POST /api/dates/:id/pin
  router.post('/dates/:id/pin', (req: Request, res: Response) => {
    const userId = req.userId!;
    const id = parseId(req.params.id as string);
    if (id === null) return res.status(400).json({ error: 'Invalid ID' });

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    dbOps.pinImportantDate(id, pairId);
    res.json({ success: true });
  });

  // DELETE /api/dates/:id
  router.delete('/dates/:id', (req: Request, res: Response) => {
    const userId = req.userId!;
    const id = parseId(req.params.id as string);
    if (id === null) return res.status(400).json({ error: 'Invalid ID' });

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    const deleted = dbOps.deleteImportantDate(id, pairId);
    if (!deleted) return res.status(404).json({ error: 'Date not found' });

    res.json({ success: true });
  });

  // GET /api/daily-question
  router.get('/daily-question', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    // Daily question rolls at 7am Beijing time (matches the client countdown).
    const today = getBjt7amDate();

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });

    // Get or assign today's question for THIS couple. Each couple gets
    // their own (pair_id, date) → question_index mapping; their "no
    // repeat" promise actually holds since the completed set is also
    // pair-scoped now.
    let index = dbOps.getQuestionAssignment(pairId, today);
    if (index === null) {
      const completed = dbOps.getCompletedQuestionIndexes(pairId);
      const available = Array.from({ length: QUESTIONS.length }, (_, i) => i).filter(i => !completed.has(i));
      if (available.length === 0) {
        // All questions answered — reset by picking from full pool
        index = Math.floor(Math.random() * QUESTIONS.length);
      } else {
        index = available[Math.floor(Math.random() * available.length)];
      }
      dbOps.setQuestionAssignment(pairId, today, index);
    }
    const question = QUESTIONS[index];

    const answers = dbOps.getDailyAnswers(today, pairId, userId);
    const bothAnswered = !!answers.mine && !!answers.partner;

    // Reactions only meaningful once both answered. Send the partner's date
    // for "ta's reaction to my answer" (correct since they react to my row).
    const myReactionToPartner = bothAnswered
      ? dbOps.getDailyReaction(userId, user.partner_id, today, 'question')
      : null;
    const partnerReactionToMe = bothAnswered
      ? dbOps.getDailyReaction(user.partner_id, userId, today, 'question')
      : null;

    res.json({
      question,
      question_index: index,
      date: today,
      my_answer: answers.mine?.answer ?? null,
      partner_answer: bothAnswered ? answers.partner!.answer : null,
      partner_answered: !!answers.partner,
      both_answered: bothAnswered,
      my_reaction_to_partner: myReactionToPartner,
      partner_reaction_to_me: partnerReactionToMe,
    });
  });

  // POST /api/daily-question/answer
  router.post('/daily-question/answer', async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { answer } = req.body;

    if (!answer || typeof answer !== 'string' || !answer.trim()) {
      return res.status(400).json({ error: 'answer is required' });
    }
    // Server-side cap. Client UI also limits to 200 chars; this is the
    // edge guard so a misbehaving client can't bloat the row.
    if (answer.length > 500) {
      return res.status(400).json({ error: 'answer max 500 characters' });
    }

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const today = getBjt7amDate();

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });

    // Get today's assigned question index for this couple
    let index = dbOps.getQuestionAssignment(pairId, today);
    if (index === null) {
      const completed = dbOps.getCompletedQuestionIndexes(pairId);
      const available = Array.from({ length: QUESTIONS.length }, (_, i) => i).filter(i => !completed.has(i));
      index = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : Math.floor(Math.random() * QUESTIONS.length);
      dbOps.setQuestionAssignment(pairId, today, index);
    }

    dbOps.submitDailyAnswer(userId, pairId, today, index, answer.trim());

    const answers = dbOps.getDailyAnswers(today, pairId, userId);
    const bothAnswered = !!answers.mine && !!answers.partner;

    const partner = dbOps.getUser(user.partner_id);
    if (partner) {
      await pushToUser(dbOps, pushFn, partner.id, bothAnswered ? 'daily_both' : 'daily_answer', user.name);
    }

    res.json({
      success: true,
      both_answered: bothAnswered,
      partner_answer: bothAnswered ? answers.partner!.answer : null,
    });
  });

  // GET /api/stats
  router.get('/stats', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.json({ total_actions: 0, my_actions: 0, partner_actions: 0, top_actions: [], hourly: [], monthly: [], first_action_date: null });
    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.json({ total_actions: 0, my_actions: 0, partner_actions: 0, top_actions: [], hourly: [], monthly: [], first_action_date: null });

    const stats = dbOps.getStats(pairId, userId);
    res.json(stats);
  });

  // POST /api/ritual
  router.post('/ritual', async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { ritual_type } = req.body;

    if (!ritual_type || (ritual_type !== 'morning' && ritual_type !== 'evening')) {
      return res.status(400).json({ error: 'ritual_type must be morning or evening' });
    }

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const localHour = getLocalHour(user.timezone);
    const isMorningWindow = localHour >= 4 && localHour <= 12;
    const isEveningWindow = localHour >= 18 || localHour < 4;

    if (ritual_type === 'morning' && !isMorningWindow) {
      return res.status(400).json({ error: 'Morning ritual available 4:00-12:59' });
    }
    if (ritual_type === 'evening' && !isEveningWindow) {
      return res.status(400).json({ error: 'Evening ritual available 18:00-3:59' });
    }

    // For evening ritual after midnight (0-3), use yesterday's date
    let ritualDate = getLocalDate(user.timezone);
    if (ritual_type === 'evening' && localHour < 4) {
      ritualDate = getYesterdayDate(ritualDate);
    }

    const inserted = dbOps.submitRitual(userId, ritual_type, ritualDate);

    // Check partner's status using partner's OWN timezone (not user's guess)
    const partner = dbOps.getUser(user.partner_id);
    const partnerTz = partner?.timezone || 'Asia/Shanghai';
    const partnerDate = getLocalDate(partnerTz);
    let partnerRitualDate = partnerDate;
    if (ritual_type === 'evening') {
      const partnerHour = getLocalHour(partnerTz);
      if (partnerHour < 4) {
        partnerRitualDate = getYesterdayDate(partnerDate);
      }
    }

    const status = dbOps.getRitualsByDates(ritualDate, partnerRitualDate, userId, user.partner_id);
    // Same-date gate matches the weekly stat's join condition: if my
    // ritual_date and partner's ritual_date diverge (cross-day window),
    // the response says "not both yet" and the lagging partner's later
    // submission of the SAME date will be the trigger that flips it.
    const bothCompleted = (ritualDate === partnerRitualDate) && (
      ritual_type === 'morning'
        ? status.myMorning && status.partnerMorning
        : status.myEvening && status.partnerEvening
    );
    if (partner) {
      if (bothCompleted) {
        await pushToUser(dbOps, pushFn, partner.id, ritual_type === 'morning' ? 'ritual_both_morning' : 'ritual_both_evening', user.name);
      } else if (inserted) {
        await pushToUser(dbOps, pushFn, partner.id, ritual_type === 'morning' ? 'ritual_morning' : 'ritual_evening', user.name);
      }
    }

    res.json({ success: true, ritual_type, ritual_date: ritualDate, both_completed: bothCompleted });
  });

  // GET /api/ritual/status
  router.get('/ritual/status', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const localHour = getLocalHour(user.timezone);
    const myDate = getLocalDate(user.timezone);

    // Use partner's OWN timezone for matching
    const partner = dbOps.getUser(user.partner_id);
    const partnerTz = partner?.timezone || 'Asia/Shanghai';
    const partnerDate = getLocalDate(partnerTz);

    // For evening: compute adjusted dates (if after midnight, look at yesterday)
    let myEveningDate = myDate;
    if (localHour < 4) {
      myEveningDate = getYesterdayDate(myDate);
    }
    const partnerHour = getLocalHour(partnerTz);
    let partnerEveningDate = partnerDate;
    if (partnerHour < 4) {
      partnerEveningDate = getYesterdayDate(partnerDate);
    }

    const morningStatus = dbOps.getRitualsByDates(myDate, partnerDate, userId, user.partner_id);
    const eveningStatus = dbOps.getRitualsByDates(myEveningDate, partnerEveningDate, userId, user.partner_id);

    // "Both" requires the SAME calendar date (each in their own tz). If
    // the two clocks are mid-cross-day (e.g. NY at 11pm yesterday, BJT
    // at noon today), the live status temporarily shows "not yet both"
    // until the lagging side catches up — keeps the live UI aligned
    // with the weekly stat's same-date join, so a ritual that doesn't
    // count in the 7-day total never falsely lights "both completed"
    // in the live card either.
    const morningBoth = (myDate === partnerDate)
      && morningStatus.myMorning && morningStatus.partnerMorning;
    const eveningBoth = (myEveningDate === partnerEveningDate)
      && eveningStatus.myEvening && eveningStatus.partnerEvening;

    let dailyRecap = null;
    if (eveningBoth) {
      // Slice on the user's local-day boundary, not UTC — otherwise a NY
      // user (UTC-4) doing 50 taps after 8pm local sees 0 interactions
      // because UTC has already rolled to next day.
      const startUtc = localDateStartToUtcIso(myEveningDate, user.timezone);
      const endUtc = localDateOffsetToUtcIso(myEveningDate, user.timezone, 1);
      dailyRecap = dbOps.getDailyRecap(userId, user.partner_id, startUtc, endUtc);
    }

    res.json({
      local_hour: localHour,
      morning: {
        my_completed: morningStatus.myMorning,
        partner_completed: morningStatus.partnerMorning,
        both_completed: morningBoth,
      },
      evening: {
        my_completed: eveningStatus.myEvening,
        partner_completed: eveningStatus.partnerEvening,
        both_completed: eveningBoth,
      },
      daily_recap: dailyRecap,
    });
  });

  // GET /api/mailbox
  router.get('/mailbox', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const sessionKey = getCurrentSessionKey();
    const revealAt = getRevealTime(sessionKey);
    const now = new Date();
    const phase = now >= revealAt ? 'revealed' : 'writing';

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    const messages = dbOps.getMailboxMessages(sessionKey, pairId, userId);

    // Multi-letter sends per session are allowed; the writer can keep
    // shipping until reveal time. `my_sealed` / `can_edit` are kept in the
    // response shape for backward compatibility with old clients but always
    // report "not sealed / can edit" during the writing phase.
    res.json({
      week_key: sessionKey,
      phase,
      // Latest of each user (loop in getMailboxMessages assigns last-row-
      // wins; statement orders ASC so the most recent ends up returned).
      // Pre-reveal the writer still doesn't see anyone's content.
      my_message: phase === 'revealed' ? (messages.mine?.content ?? null) : null,
      my_sealed: false,
      partner_message: phase === 'revealed' ? (messages.partner?.content ?? null) : null,
      partner_wrote: phase === 'revealed' ? !!messages.partner : undefined,
      reveal_at: revealAt.toISOString(),
      can_edit: phase === 'writing',
    });
  });

  // POST /api/mailbox — seal-on-submit: first write wins and becomes read-only.
  router.post('/mailbox', async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { content } = req.body;

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }
    if (content.length > 500) {
      return res.status(400).json({ error: 'content max 500 characters' });
    }

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const sessionKey = getCurrentSessionKey();
    const revealAt = getRevealTime(sessionKey);

    if (new Date() >= revealAt) {
      return res.status(400).json({ error: 'Writing period has ended' });
    }

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    // Multiple letters per session are allowed — every send produces a new
    // sealed row that opens at the next reveal boundary alongside the rest.
    dbOps.submitMailboxMessage(userId, pairId, sessionKey, content.trim());

    const partner = dbOps.getUser(user.partner_id);
    if (partner) {
      await pushToUser(dbOps, pushFn, partner.id, 'mailbox_written', user.name);
    }

    res.json({ success: true });
  });

  // GET /api/mailbox/archive
  router.get('/mailbox/archive', (req: Request, res: Response) => {
    const userId = req.userId!;
    const limit = parseInt(req.query.limit as string, 10) || 10;

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.json({ weeks: [] });
    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.json({ weeks: [] });

    // One row per partner-authored letter. Hide rows whose session reveal
    // time hasn't arrived yet — those are still in transit on the
    // recipient's side.
    const allLetters = dbOps.getMailboxArchive(userId, pairId, user.partner_id, Math.min(limit, 50));
    const now = new Date();
    const weeks = allLetters.filter(w => now >= getRevealTime(w.week_key));

    res.json({ weeks });
  });

  // GET /api/outbox — sender-side view of letters in transit.
  // Mailbox: my submissions in the current session that haven't reveal-
  // passed yet. Capsule: my capsules whose unlock_at is in the future.
  // Once a letter "arrives" (reveal time / unlock time elapses), it
  // disappears from the outbox automatically.
  //
  // Also returns `has_fresh`: true iff at least one pending letter was
  // queued AFTER the user's stored `outbox_last_seen` marker. Drives the
  // 🚩 next to 发件箱 + the 信箱 tab dot. Stored server-side so it
  // survives logout / reinstall — clearing the client's local storage
  // can't lose this state.
  router.get('/outbox', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.json({ mailbox_pending: [], capsule_pending: [], has_fresh: false });
    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.json({ mailbox_pending: [], capsule_pending: [], has_fresh: false });

    const now = new Date();
    const sessionKey = getCurrentSessionKey();
    const revealAt = getRevealTime(sessionKey);

    // Mailbox: only the current session can hold pre-reveal letters
    // (past sessions are always already revealed by the time the user
    // could request them). If we're already past this session's reveal
    // moment, return none.
    let mailbox_pending: { id: number; week_key: string; content: string; created_at: string; reveal_at: string }[] = [];
    if (now < revealAt) {
      mailbox_pending = dbOps.getMyMailboxInSession(userId, pairId, sessionKey).map(r => ({
        id: r.id,
        week_key: r.week_key,
        content: r.content,
        created_at: r.created_at,
        reveal_at: revealAt.toISOString(),
      }));
    }

    // Capsule: my capsules with a future unlock instant. Includes both
    // partner-bound and self-bound — the user wrote them, so seeing them
    // in their own outbox is the expected mental model.
    const nowIso = now.toISOString();
    const capsule_pending = dbOps.getCapsules(pairId)
      .filter(c => c.user_id === userId && c.unlock_at > nowIso && !c.opened_at)
      .map(c => ({
        id: c.id,
        content: c.content,
        unlock_date: c.unlock_date,
        unlock_at: c.unlock_at,
        visibility: c.visibility,
        created_at: c.created_at,
      }));

    // Empty marker = "user has never opened the outbox" → every pending
    // letter counts as fresh (epoch-style anchor, same effect as comparing
    // against '1970-01-01'). Both sides of the lex compare are SQLite
    // datetime format so direct `>` is well-defined.
    const seen = user.outbox_last_seen || '';
    let has_fresh = false;
    for (const m of mailbox_pending) {
      if (m.created_at > seen) { has_fresh = true; break; }
    }
    if (!has_fresh) {
      for (const c of capsule_pending) {
        if (c.created_at > seen) { has_fresh = true; break; }
      }
    }

    res.json({ mailbox_pending, capsule_pending, has_fresh });
  });

  // POST /api/outbox/seen — advance the user's outbox-seen marker to now.
  // Called from OutboxScreen close so subsequent /api/outbox responses
  // report `has_fresh: false` until the user sends another letter.
  router.post('/outbox/seen', (req: Request, res: Response) => {
    const userId = req.userId!;
    dbOps.markOutboxSeen(userId);
    res.json({ success: true });
  });

  // GET / POST /api/daily/seen — per-user "I have seen partner's daily
  // content" flags. Server-stored so the red dot on the 每日 tab stays
  // consistent across devices for the same account.
  router.get('/daily/seen', (req: Request, res: Response) => {
    const userId = req.userId!;
    res.json(dbOps.getDailySeen(userId));
  });
  router.post('/daily/seen', (req: Request, res: Response) => {
    const userId = req.userId!;
    const { date, pa, ps } = req.body || {};
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    dbOps.setDailySeen(userId, date, !!pa, !!ps);
    res.json({ success: true });
  });

  // GET / POST /api/inbox/seen — ISO timestamp of last inbox visit.
  // POST sets to "now"; only-advance semantics in dbOps so an out-of-
  // order client write can't roll the marker back.
  router.get('/inbox/seen', (req: Request, res: Response) => {
    const userId = req.userId!;
    res.json({ seen_at: dbOps.getInboxLastSeen(userId) });
  });
  router.post('/inbox/seen', (req: Request, res: Response) => {
    const userId = req.userId!;
    dbOps.setInboxLastSeen(userId, new Date().toISOString());
    res.json({ success: true });
  });

  // GET / PUT /api/letter-draft — the in-progress letter the user is
  // composing in WriteLetterScreen. Was AsyncStorage-only; moving it
  // server-side lets the user pick up the draft on another device.
  // Submit on the mailbox path clears it via the same PUT with empty
  // string.
  router.get('/letter-draft', (req: Request, res: Response) => {
    const userId = req.userId!;
    res.json({ draft: dbOps.getLetterDraft(userId) });
  });
  router.put('/letter-draft', (req: Request, res: Response) => {
    const userId = req.userId!;
    const draft = req.body?.draft;
    if (typeof draft !== 'string') {
      return res.status(400).json({ error: 'draft must be a string' });
    }
    // Hard cap on draft length so a runaway client can't blow up storage.
    // Same 8000 ceiling the front-end enforces (`MAX_LETTER_LEN`).
    if (draft.length > 8000) {
      return res.status(400).json({ error: 'draft too long' });
    }
    dbOps.setLetterDraft(userId, draft);
    res.json({ success: true });
  });

  // Inbox soft-delete endpoints — used by the inbox & trash views.
  // Body: { kind: 'mailbox' | 'capsule', ref_id: number }

  // Helper: validate kind + ref_id and resolve referenced row exists + is
  // visible to this user as a recipient. Returns null on validation failure
  // (and writes the error response); a parsed { kind, refId } on success.
  function validateInboxRef(req: Request, res: Response): { kind: 'mailbox' | 'capsule'; refId: number; userId: string; pairId: string } | null {
    const userId = req.userId!;
    const { kind, ref_id } = req.body || {};
    if (kind !== 'mailbox' && kind !== 'capsule') {
      res.status(400).json({ error: 'Invalid kind' });
      return null;
    }
    if (typeof ref_id !== 'number' || !Number.isInteger(ref_id) || ref_id <= 0) {
      res.status(400).json({ error: 'Invalid ref_id' });
      return null;
    }
    const user = dbOps.getUser(userId);
    if (!user || !user.partner_id) {
      res.status(400).json({ error: 'Not paired' });
      return null;
    }
    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) {
      res.status(409).json({ error: 'Pair state inconsistent' });
      return null;
    }

    // Authorization: user must be a recipient of the referenced item.
    if (kind === 'mailbox') {
      // The referenced mailbox row must be authored by the partner (user
      // is the recipient).
      const row = dbOps.getMailboxMessageById(ref_id);
      if (!row || row.user_id !== user.partner_id) {
        res.status(404).json({ error: 'Letter not found' });
        return null;
      }
    } else {
      const row = dbOps.getCapsuleById(ref_id);
      if (!row) {
        res.status(404).json({ error: 'Letter not found' });
        return null;
      }
      // Outgoing (author=me, visibility=partner) is the user's sent-mail —
      // not their inbox, so they can't trash it.
      if (row.user_id === userId && row.visibility === 'partner') {
        res.status(403).json({ error: 'Cannot trash outgoing letter' });
        return null;
      }
      // Self capsules belong to the author only.
      if (row.visibility === 'self' && row.user_id !== userId) {
        res.status(404).json({ error: 'Letter not found' });
        return null;
      }
    }

    return { kind, refId: ref_id, userId, pairId };
  }

  // POST /api/inbox/trash — move letter to trash
  router.post('/inbox/trash', (req: Request, res: Response) => {
    const v = validateInboxRef(req, res);
    if (!v) return;
    // Reject trashing an unopened capsule. The trash listing query joins on
    // `opened_at IS NOT NULL`, so a trashed-but-unopened capsule would be
    // hidden from BOTH the inbox and the trash — silently disappearing with
    // no way to restore. The UI only exposes trash on opened capsules; this
    // is the API-side guard for direct callers.
    if (v.kind === 'capsule') {
      const capsule = dbOps.getCapsuleById(v.refId);
      if (capsule && !capsule.opened_at) {
        return res.status(400).json({ error: 'Cannot trash an unopened capsule' });
      }
    }
    dbOps.setInboxAction(v.userId, v.pairId, v.kind, v.refId, 'trashed');
    res.json({ success: true });
  });

  // POST /api/inbox/restore — restore from trash to inbox
  router.post('/inbox/restore', (req: Request, res: Response) => {
    const v = validateInboxRef(req, res);
    if (!v) return;
    dbOps.clearInboxAction(v.userId, v.kind, v.refId);
    res.json({ success: true });
  });

  // POST /api/inbox/purge — permanently hide from this recipient
  router.post('/inbox/purge', (req: Request, res: Response) => {
    const v = validateInboxRef(req, res);
    if (!v) return;
    dbOps.setInboxAction(v.userId, v.pairId, v.kind, v.refId, 'purged');
    res.json({ success: true });
  });

  // GET /api/inbox/trash — list trashed inbox items for this user
  router.get('/inbox/trash', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.json({ items: [] });

    const items = dbOps.getTrashedInboxItems(userId, user.partner_id);
    res.json({ items });
  });

  // GET /api/weekly-report
  router.get('/weekly-report', (req: Request, res: Response) => {
    const userId = req.userId!;
    const week = req.query.week as string | undefined;
    // Validate user-supplied week — without this, `new Date('foo')` is
    // Invalid Date and the subsequent toISOString() throws → 500.
    if (week && !isValidDateString(week)) {
      return res.status(400).json({ error: 'week must be YYYY-MM-DD' });
    }

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.json({ total: 0 });

    // Default to this week's Monday in the user's timezone (not UTC). The
    // start/end below pin to local-midnight in the user's tz, expressed as
    // SQLite-format UTC ('YYYY-MM-DD HH:MM:SS') so a NY user's "this week"
    // begins at UTC Mon-04:00 (= NY Mon-00:00 EDT), not UTC Mon-00:00.
    const weekStart = week || getCurrentWeekMonday(user.timezone);
    const weekEndDate = new Date(weekStart);
    weekEndDate.setDate(weekEndDate.getDate() + 7);
    const weekEnd = weekEndDate.toISOString().slice(0, 10);
    const actionsStart = localDateStartToUtcIso(weekStart, user.timezone).slice(0, 19).replace('T', ' ');
    const actionsEnd = localDateStartToUtcIso(weekEnd, user.timezone).slice(0, 19).replace('T', ' ');

    const data = dbOps.getWeeklyReportData(userId, user.partner_id, weekStart, weekEnd, actionsStart, actionsEnd);
    const streak = dbOps.getStreak(userId, user.partner_id);

    const changePct = data.lastWeekTotal > 0
      ? Math.round(((data.total - data.lastWeekTotal) / data.lastWeekTotal) * 100)
      : 0;

    // Temperature: interaction(40%) + question(20%) + ritual(20%) + streak(20%)
    const interactionScore = Math.min(data.total / 50, 1) * 40;
    const questionScore = (data.dailyQuestionDays / 7) * 20;
    const ritualScore = ((data.ritualMorningDays + data.ritualEveningDays) / 14) * 20;
    const streakScore = Math.min(streak / 30, 1) * 20;
    const temperature = Math.round(interactionScore + questionScore + ritualScore + streakScore);

    let temperatureLabel = '❄️ 冷淡期';
    if (temperature >= 80) temperatureLabel = '🔥🔥🔥 热恋中';
    else if (temperature >= 60) temperatureLabel = '🔥🔥 甜蜜期';
    else if (temperature >= 40) temperatureLabel = '🔥 升温中';
    else if (temperature >= 20) temperatureLabel = '☀️ 温暖期';

    res.json({
      week_key: weekStart,
      total: data.total,
      last_week_total: data.lastWeekTotal,
      change_percent: changePct,
      my_count: data.myCount,
      partner_count: data.partnerCount,
      streak,
      top_actions: data.topActions,
      daily_question_rate: `${data.dailyQuestionDays}/7`,
      ritual_morning_rate: `${data.ritualMorningDays}/7`,
      ritual_evening_rate: `${data.ritualEveningDays}/7`,
      temperature,
      temperature_label: temperatureLabel,
    });
  });

  // POST /api/capsules
  router.post('/capsules', async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { content, unlock_date, unlock_at, visibility } = req.body;

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }
    if (content.length > 1000) {
      return res.status(400).json({ error: 'content max 1000 characters' });
    }
    if (!unlock_date || typeof unlock_date !== 'string') {
      return res.status(400).json({ error: 'unlock_date is required' });
    }
    if (!isValidDateString(unlock_date)) {
      return res.status(400).json({ error: 'unlock_date must be YYYY-MM-DD' });
    }
    // unlock_at is the new minute-precision unlock instant. Older clients may
    // not send it; fall back to midnight UTC of unlock_date so existing
    // behavior is preserved. New clients send a full ISO timestamp computed
    // from the sender's tz-aware picker.
    let unlockAtIso: string;
    if (unlock_at && typeof unlock_at === 'string') {
      const t = new Date(unlock_at).getTime();
      if (!Number.isFinite(t)) {
        return res.status(400).json({ error: 'unlock_at must be a valid ISO timestamp' });
      }
      unlockAtIso = new Date(t).toISOString();
    } else {
      unlockAtIso = `${unlock_date}T00:00:00.000Z`;
    }
    const vis: 'self' | 'partner' = visibility === 'self' ? 'self' : 'partner';

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    // Reject anything that doesn't unlock strictly in the future. Compared
    // as ISO timestamps (UTC) — works regardless of sender/receiver tz.
    const nowIso = new Date().toISOString();
    if (unlockAtIso <= nowIso) {
      return res.status(400).json({ error: 'unlock_at must be in the future' });
    }

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });

    const existing = dbOps.getCapsules(pairId);
    if (existing.filter(c => !c.opened_at).length >= 50) {
      return res.status(400).json({ error: 'Maximum 50 pending capsules' });
    }

    const capsule = dbOps.createCapsule(userId, user.partner_id, pairId, content.trim(), unlock_date, unlockAtIso, vis);

    // Notify partner only when this capsule is meant for them. Body includes a
    // day+hour countdown so the partner knows when to expect it.
    if (vis === 'partner') {
      const partner = dbOps.getUser(user.partner_id);
      if (partner) {
        const countdown = formatDayHourCountdown(unlock_date, partner.timezone);
        await pushToUser(dbOps, pushFn, partner.id, 'capsule_buried', user.name, { countdown });
      }
    }

    res.json({ id: capsule.id, unlock_date: capsule.unlock_date, unlock_at: capsule.unlock_at, created_at: capsule.created_at });
  });

  // GET /api/capsules
  router.get('/capsules', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.json({ capsules: [] });
    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.json({ capsules: [] });

    const nowIso = new Date().toISOString();
    // 'self' capsules are private to the author. 'partner' (default) capsules
    // are visible to both — the recipient gets the surprise + countdown push.
    // Recipient-side soft-deletes (trashed/purged) hide the capsule from the
    // current user's listing, but only if they're a recipient (not the author
    // of an outgoing partner-vis capsule — that's their sent-mail).
    const capsules = dbOps.getCapsules(pairId)
      .filter(c => c.visibility !== 'self' || c.user_id === userId)
      .filter(c => {
        // Outgoing (author=me, visibility=partner) is never affected by inbox
        // soft delete — it's not in our inbox.
        const isOutgoing = c.user_id === userId && c.visibility === 'partner';
        if (isOutgoing) return true;
        const status = dbOps.getInboxActionStatus(userId, 'capsule', c.id);
        return status !== 'trashed' && status !== 'purged';
      })
      .map(c => ({
        id: c.id,
        author: c.user_id === userId ? 'me' : 'partner',
        content: c.opened_at ? c.content : null,
        unlock_date: c.unlock_date,
        unlock_at: c.unlock_at,
        // Minute-precision unlock check. Compare full ISO strings — both in
        // UTC, so lexicographic compare is equivalent to chronological.
        is_unlockable: c.unlock_at <= nowIso && !c.opened_at,
        opened_at: c.opened_at,
        visibility: c.visibility,
        created_at: c.created_at,
      }));

    res.json({ capsules });
  });

  // POST /api/capsules/:id/open
  router.post('/capsules/:id/open', (req: Request, res: Response) => {
    const userId = req.userId!;
    const id = parseId(req.params.id as string);
    if (id === null) return res.status(400).json({ error: 'Invalid ID' });

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const pairId = user.partner_id ? dbOps.couplesGetActivePairId(userId, user.partner_id) : null;
    const capsules = pairId ? dbOps.getCapsules(pairId) : [];
    const capsule = capsules.find(c => c.id === id);
    if (!capsule) return res.status(404).json({ error: 'Capsule not found' });

    // 'self' capsules are private to the author. Returning 404 (not 403)
    // keeps the existence of the capsule itself secret from the partner —
    // they can't tell whether `id` is wrong or just owned by the author.
    if (capsule.visibility === 'self' && capsule.user_id !== userId) {
      return res.status(404).json({ error: 'Capsule not found' });
    }

    // Recipient-side soft delete: if this user has trashed or purged the
    // capsule, treat it as gone — even direct id access via this endpoint
    // must not return content. Outgoing partner-vis is exempt; it's the
    // user's sent-mail, never tracked in inbox_actions.
    const isOutgoing = capsule.user_id === userId && capsule.visibility === 'partner';
    if (!isOutgoing) {
      const status = dbOps.getInboxActionStatus(userId, 'capsule', id);
      if (status === 'trashed' || status === 'purged') {
        return res.status(404).json({ error: 'Capsule not found' });
      }
    }

    const nowIso = new Date().toISOString();
    if (capsule.unlock_at > nowIso) {
      return res.status(400).json({ error: 'Capsule is not yet unlockable' });
    }

    if (capsule.opened_at) {
      return res.json({ success: true, content: capsule.content });
    }

    dbOps.openCapsule(id);
    res.json({ success: true, content: capsule.content });
  });

  // GET /api/bucket
  router.get('/bucket', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.json({ items: [], total: 0, completed_count: 0 });
    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.json({ items: [], total: 0, completed_count: 0 });

    const items = dbOps.getBucketItems(pairId).map(i => ({
      ...i,
      created_by: i.user_id === userId ? 'me' : 'partner',
    }));
    const completedCount = items.filter(i => i.completed).length;

    res.json({ items, total: items.length, completed_count: completedCount });
  });

  // POST /api/bucket
  router.post('/bucket', async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { title, category } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (title.length > 100) return res.status(400).json({ error: 'title max 100 characters' });

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    const existingItems = dbOps.getBucketItems(pairId);
    if (existingItems.length >= 100) return res.status(400).json({ error: 'Maximum 100 items' });

    const item = dbOps.createBucketItem(userId, user.partner_id, pairId, title.trim(), category || null);

    const partner = dbOps.getUser(user.partner_id);
    if (partner) {
      await pushToUser(dbOps, pushFn, partner.id, 'bucket_new', user.name);
    }

    res.json({ item });
  });

  // POST /api/bucket/:id/complete
  router.post('/bucket/:id/complete', async (req: Request, res: Response) => {
    const userId = req.userId!;
    const id = parseId(req.params.id as string);
    if (id === null) return res.status(400).json({ error: 'Invalid ID' });

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    // Verify item belongs to this couple
    const items = dbOps.getBucketItems(pairId);
    const item = items.find(i => i.id === id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const updated = dbOps.completeBucketItem(id, userId);
    if (!updated) return res.status(404).json({ error: 'Item not found' });

    if (user.partner_id) {
      const partner = dbOps.getUser(user.partner_id);
      if (partner) {
        await pushToUser(dbOps, pushFn, partner.id, 'bucket_complete', user.name, { title: item.title });
      }
    }

    res.json({ success: true });
  });

  // POST /api/bucket/:id/uncomplete
  router.post('/bucket/:id/uncomplete', (req: Request, res: Response) => {
    const userId = req.userId!;
    const id = parseId(req.params.id as string);
    if (id === null) return res.status(400).json({ error: 'Invalid ID' });

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    // Verify item belongs to this couple
    const items = dbOps.getBucketItems(pairId);
    if (!items.some(i => i.id === id)) return res.status(404).json({ error: 'Item not found' });

    const updated = dbOps.uncompleteBucketItem(id);
    if (!updated) return res.status(404).json({ error: 'Item not found' });

    res.json({ success: true });
  });

  // DELETE /api/bucket/:id
  router.delete('/bucket/:id', (req: Request, res: Response) => {
    const userId = req.userId!;
    const id = parseId(req.params.id as string);
    if (id === null) return res.status(400).json({ error: 'Invalid ID' });

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const deleted = dbOps.deleteBucketItem(id, userId, user.partner_id);
    if (!deleted) return res.status(404).json({ error: 'Item not found' });

    res.json({ success: true });
  });

  // POST /api/snaps (multipart upload)
  // Atomic: write to a tmp file, validate, then rename into place. Prevents
  // a re-upload from clobbering today's existing photo before the DB check
  // rejects it.
  const TMP_DIR = path.join(__dirname, '..', 'data', 'snaps_tmp');
  const snapStorage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      cb(null, TMP_DIR);
    },
    filename: (req, _file, cb) => {
      cb(null, `${req.userId}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.jpg`);
    },
  });
  const snapUpload = multer({
    storage: snapStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new Error('Only images allowed'));
    },
  });

  router.post('/snaps', snapUpload.single('photo'), async (req: Request, res: Response) => {
    const userId = req.userId!;
    if (!req.file) return res.status(400).json({ error: 'photo is required' });
    const tmpPath = req.file.path;
    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch {} };

    const user = dbOps.getUser(userId);
    if (!user) { cleanup(); return res.status(404).json({ error: 'User not found' }); }
    if (!user.partner_id) { cleanup(); return res.status(400).json({ error: 'Not paired' }); }

    const snapDate = getBjt7amDate();
    const photoPath = `${userId}/${snapDate}.jpg`;

    // DB-first via INSERT OR IGNORE inside a tx that also reads partner's
    // snap. Without this, two parallel uploads from the same user could
    // both pass a pre-check and then race the file rename — leaving one
    // user's photo on disk and the other's row in the DB.
    const { saved, bothSnapped } = dbOps.saveSnapAtomic(userId, user.partner_id, snapDate, photoPath);
    if (!saved) {
      cleanup();
      return res.status(400).json({ error: 'Already snapped today' });
    }

    // Only after the row is claimed do we move the tmp into place. If the
    // rename fails we must roll back the row so the user can retry —
    // otherwise the row would point to a missing file forever.
    const finalDir = path.join(__dirname, '..', 'data', 'snaps', userId);
    fs.mkdirSync(finalDir, { recursive: true });
    const finalPath = path.join(finalDir, `${snapDate}.jpg`);
    try {
      fs.renameSync(tmpPath, finalPath);
    } catch (err) {
      dbOps.deleteSnap(userId, snapDate);
      cleanup();
      return res.status(500).json({ error: 'Failed to save photo' });
    }

    // Re-check partner's state right before the push to close the millisecond
    // race where partner's tx commits between mine and the push send.
    const partner = dbOps.getUser(user.partner_id);
    const partnerSnapNow = dbOps.getSnap(user.partner_id, snapDate);
    const both = bothSnapped || !!partnerSnapNow;
    if (partner) {
      await pushToUser(dbOps, pushFn, partner.id, both ? 'snap_both' : 'snap_submitted', user.name);
    }

    res.json({ success: true, both_snapped: both, snap_date: snapDate });
  });

  // GET /api/snaps/today
  router.get('/snaps/today', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = getBjt7amDate();
    const mySnap = dbOps.getSnap(userId, today);
    const partnerSnap = user.partner_id ? dbOps.getSnap(user.partner_id, today) : undefined;

    const bothSnapped = !!mySnap && !!partnerSnap;
    const myReactionToPartner = (bothSnapped && user.partner_id)
      ? dbOps.getDailyReaction(userId, user.partner_id, today, 'snap')
      : null;
    const partnerReactionToMe = (bothSnapped && user.partner_id)
      ? dbOps.getDailyReaction(user.partner_id, userId, today, 'snap')
      : null;

    res.json({
      snap_date: today,
      my_snapped: !!mySnap,
      partner_snapped: !!partnerSnap,
      my_photo: mySnap?.photo_path ? signImagePath(mySnap.photo_path) : null,
      // Mirror the daily-question reveal rule: partner content only after
      // BOTH have submitted. Without this, calling /snaps/today after the
      // partner has snapped (and before me) leaks ta's photo URL.
      partner_photo: bothSnapped && partnerSnap?.photo_path ? signImagePath(partnerSnap.photo_path) : null,
      my_reaction_to_partner: myReactionToPartner,
      partner_reaction_to_me: partnerReactionToMe,
    });
  });

  // GET /api/snaps
  router.get('/snaps', (req: Request, res: Response) => {
    const userId = req.userId!;
    const month = req.query.month as string;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month parameter required (YYYY-MM)' });
    }
    // Range-check the month so a client passing "2024-13" doesn't slip past
    // the regex and then silently produce a query against month "14".
    const monthNum = parseInt(month.slice(5, 7), 10);
    if (monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ error: 'month must be 01-12' });
    }

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.json({ snaps: [] });

    const snaps = dbOps.getSnaps(userId, user.partner_id, month).map(s => {
      const both = !!s.user_photo && !!s.partner_photo;
      return {
        date: s.snap_date,
        my_photo: s.user_photo ? signImagePath(s.user_photo) : null,
        // Same gating as /snaps/today: don't expose ta's photo on past days
        // where I never snapped, otherwise the calendar can be used to peek.
        partner_photo: both && s.partner_photo ? signImagePath(s.partner_photo) : null,
        both_snapped: both,
      };
    });

    res.json({ snaps });
  });

  // POST /api/urge — nudge partner to fill today's question or take today's snap.
  // Only valid when caller has filled their side AND partner hasn't.
  router.post('/urge', async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { type } = req.body;

    if (type !== 'question' && type !== 'snap') {
      return res.status(400).json({ error: 'type must be "question" or "snap"' });
    }

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const today = getBjt7amDate();
    if (type === 'question') {
      const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
      if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
      const answers = dbOps.getDailyAnswers(today, pairId, userId);
      if (!answers.mine) return res.status(400).json({ error: 'Answer your own first' });
      if (answers.partner) return res.status(400).json({ error: 'Partner already answered' });
    } else {
      if (!dbOps.getSnap(userId, today)) return res.status(400).json({ error: 'Snap your own first' });
      if (dbOps.getSnap(user.partner_id, today)) return res.status(400).json({ error: 'Partner already snapped' });
    }

    const partner = dbOps.getUser(user.partner_id);
    if (partner) {
      await pushToUser(dbOps, pushFn, partner.id, type === 'question' ? 'urge_question' : 'urge_snap', user.name);
    }

    res.json({ success: true });
  });

  // POST /api/daily-reaction — 👍/👎 to partner's question answer or snap.
  // Only valid after both have filled their side.
  router.post('/daily-reaction', async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { type, reaction } = req.body;

    if (type !== 'question' && type !== 'snap') {
      return res.status(400).json({ error: 'type must be "question" or "snap"' });
    }
    if (reaction !== 'up' && reaction !== 'down') {
      return res.status(400).json({ error: 'reaction must be "up" or "down"' });
    }

    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.partner_id) return res.status(400).json({ error: 'Not paired' });

    const today = getBjt7amDate();
    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) return res.status(409).json({ error: 'Pair state inconsistent' });
    if (type === 'question') {
      const answers = dbOps.getDailyAnswers(today, pairId, userId);
      if (!answers.mine || !answers.partner) {
        return res.status(400).json({ error: 'Both must answer before reacting' });
      }
    } else {
      if (!dbOps.getSnap(userId, today) || !dbOps.getSnap(user.partner_id, today)) {
        return res.status(400).json({ error: 'Both must snap before reacting' });
      }
    }
    const targetDate = today;

    // One-shot: a reaction, once made, cannot be changed. Client UI also
    // disables the buttons, but server enforces the same so a misbehaving
    // client can't flip it via direct API.
    const existing = dbOps.getDailyReaction(userId, user.partner_id, targetDate, type);
    if (existing) {
      return res.status(400).json({ error: '已经评价过了，不能修改' });
    }

    dbOps.setDailyReaction(userId, user.partner_id, pairId, targetDate, type, reaction);

    const partner = dbOps.getUser(user.partner_id);
    if (partner) {
      const pushType = `react_${type}_${reaction}` as 'react_question_up' | 'react_question_down' | 'react_snap_up' | 'react_snap_down';
      await pushToUser(dbOps, pushFn, partner.id, pushType, user.name);
    }

    res.json({ success: true, reaction });
  });

  // GET /api/ws-ticket
  router.get('/ws-ticket', (req: Request, res: Response) => {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ticket = createWsTicket(userId, req.sessionId);
    res.json({ ticket, expires_in: 30 });
  });

  // ── 每日一帖 (sticky notes) ───────────────────────────────────────────────
  // Lifecycle: 来一帖 → POST /stickies/temp creates a {note,block} pair both
  // status='temp' (invisible to partner). 贴上去 → POST /stickies/temp/post
  // flips both to posted/committed and pushes partner. Already-posted sticky
  // can grow with 再写点 / 先写这么多 — each appended block is also a
  // temp→committed lifecycle scoped to (sticky, author).

  const STICKY_CONTENT_MAX = 1000;
  const STICKY_WALL_LIMIT = 200;

  // Resolve the requester + partner; bail with the right error if not paired.
  // Returns null and sends the response on failure.
  function requirePair(req: Request, res: Response): { userId: string; partnerId: string; pairId: string; userName: string } | null {
    const userId = req.userId!;
    const user = dbOps.getUser(userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return null;
    }
    if (!user.partner_id) {
      res.status(400).json({ error: 'Not paired' });
      return null;
    }
    const pairId = dbOps.couplesGetActivePairId(userId, user.partner_id);
    if (!pairId) {
      res.status(409).json({ error: 'Pair state inconsistent' });
      return null;
    }
    return { userId, partnerId: user.partner_id, pairId, userName: user.name };
  }

  // Given a posted sticky id from path params, ensure the requester is part of
  // the couple stamped on the sticky. Returns the row or null after writing
  // the response.
  function loadStickyOrFail(req: Request, res: Response, ctx: { userId: string; partnerId: string; pairId: string }): ReturnType<DbOps['getStickyForCouple']> | null {
    const id = parseId(req.params.id as string);
    if (id === null) {
      res.status(400).json({ error: 'Invalid ID' });
      return null;
    }
    const sticky = dbOps.getStickyForCouple(id, ctx.pairId);
    if (!sticky) {
      res.status(404).json({ error: 'Sticky not found' });
      return null;
    }
    if (sticky.status !== 'posted') {
      res.status(400).json({ error: 'Sticky not posted yet' });
      return null;
    }
    return sticky;
  }

  // GET /api/stickies — wall + my unposted temp + my temp comments.
  router.get('/stickies', (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    const { userId, partnerId, pairId } = ctx;

    const stickies = dbOps.listWallStickies(pairId, STICKY_WALL_LIMIT);
    const stickyIds = stickies.map(s => s.id);
    const blocks = dbOps.listCommittedBlocksForStickies(stickyIds);
    const seen = dbOps.listSeenForStickies(userId, stickyIds);

    const blocksBySticky = new Map<number, typeof blocks>();
    for (const b of blocks) {
      const arr = blocksBySticky.get(b.sticky_id) ?? [];
      arr.push(b);
      blocksBySticky.set(b.sticky_id, arr);
    }

    // Per-recipient unread = max committed block id authored by partner > my
    // last_seen cursor for this sticky. My own posts/comments never trigger
    // an unread on my own side.
    const wall = stickies.map(s => {
      const myBlocks = blocksBySticky.get(s.id) ?? [];
      const partnerBlocks = myBlocks.filter(b => b.author_id === partnerId);
      const maxPartnerBlockId = partnerBlocks.length
        ? partnerBlocks[partnerBlocks.length - 1].id
        : 0;
      const lastSeen = seen.get(s.id) ?? 0;
      const unread = maxPartnerBlockId > lastSeen;

      // Fetch any draft block by me on this sticky so the editor can reopen
      // mid-comment if the user backgrounded the app while writing.
      const myTempBlock = dbOps.getTempBlock(s.id, userId);

      return {
        id: s.id,
        author_role: s.user_id === userId ? 'me' : 'partner',
        layout_x: s.layout_x,
        layout_rotation: s.layout_rotation,
        posted_at: s.posted_at,
        unread,
        blocks: myBlocks.map(b => ({
          id: b.id,
          author_role: b.author_id === userId ? 'me' : 'partner',
          content: b.content,
          committed_at: b.committed_at,
          layout_rotation: b.layout_rotation,
        })),
        my_temp_block: myTempBlock
          ? { content: myTempBlock.content }
          : null,
      };
    });

    const myTempSticky = dbOps.getTempSticky(userId);
    let myTemp = null;
    if (myTempSticky) {
      const tempBlock = dbOps.getTempBlock(myTempSticky.id, userId);
      myTemp = {
        sticky_id: myTempSticky.id,
        content: tempBlock?.content ?? '',
        created_at: myTempSticky.created_at,
      };
    }

    res.json({ stickies: wall, my_temp: myTemp });
  });

  // POST /api/stickies/temp — 来一帖 (idempotent; returns existing if present).
  router.post('/stickies/temp', (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    const { userId, partnerId } = ctx;

    const existing = dbOps.getTempSticky(userId);
    if (existing) {
      const block = dbOps.getTempBlock(existing.id, userId);
      return res.json({
        sticky_id: existing.id,
        content: block?.content ?? '',
        created_at: existing.created_at,
      });
    }
    const { sticky, block } = dbOps.createTempSticky(userId, partnerId, ctx.pairId);
    res.json({
      sticky_id: sticky.id,
      content: block.content,
      created_at: sticky.created_at,
    });
  });

  // PUT /api/stickies/temp — autosave while typing.
  router.put('/stickies/temp', (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    if (content.length > STICKY_CONTENT_MAX) {
      return res.status(400).json({ error: `content max ${STICKY_CONTENT_MAX} characters` });
    }
    const ok = dbOps.updateTempStickyContent(ctx.userId, content);
    if (!ok) return res.status(404).json({ error: 'No temp sticky' });
    res.json({ success: true });
  });

  // DELETE /api/stickies/temp — 不写了 / 下拉关闭.
  router.delete('/stickies/temp', (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    dbOps.deleteTempSticky(ctx.userId);
    res.json({ success: true });
  });

  // POST /api/stickies/temp/post — 贴上去.
  router.post('/stickies/temp/post', async (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    const { userId, partnerId, userName } = ctx;
    const { content } = req.body || {};
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }
    if (content.length > STICKY_CONTENT_MAX) {
      return res.status(400).json({ error: `content max ${STICKY_CONTENT_MAX} characters` });
    }

    // Layout is anchored to the *creator's* POV: layout_x is always picked in
    // the left half [0.05..0.45]. The client mirrors x and rotation when the
    // viewer is not the creator, so each side sees their own posts on the
    // left and partner's on the right. Rotation magnitude is gentle —
    // [1°, 5°] with a random sign — enough to feel hand-stuck without the
    // page turning into a tilted mess.
    const layoutX = 0.05 + Math.random() * 0.4;
    const sign = Math.random() > 0.5 ? 1 : -1;
    const layoutRotation = sign * (1 + Math.random() * 4); // ±1°..±5°

    const result = dbOps.postSticky(userId, content.trim(), layoutX, layoutRotation);
    if (!result) {
      return res.status(404).json({ error: 'No temp sticky to post' });
    }

    // Push partner if offline; socket update either way (sender's client also
    // listens — it filters by `from`).
    const partner = dbOps.getUser(partnerId);
    if (partner && !isUserOnline(partnerId)) {
      await pushToUser(dbOps, pushFn, partnerId, 'sticky_posted', userName);
    }
    emitToCouple(userId, partnerId, 'sticky_update', {
      from: userId,
      kind: 'posted',
      sticky_id: result.sticky.id,
    });

    res.json({
      sticky_id: result.sticky.id,
      block_id: result.block.id,
      layout_x: result.sticky.layout_x,
      layout_rotation: result.sticky.layout_rotation,
      posted_at: result.sticky.posted_at,
    });
  });

  // POST /api/stickies/:id/blocks/temp — 再写点 (idempotent per (sticky,author)).
  router.post('/stickies/:id/blocks/temp', (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    const sticky = loadStickyOrFail(req, res, ctx);
    if (!sticky) return;

    const existing = dbOps.getTempBlock(sticky.id, ctx.userId);
    if (existing) {
      return res.json({ block_id: existing.id, content: existing.content });
    }
    const block = dbOps.createTempBlock(sticky.id, ctx.userId);
    res.json({ block_id: block.id, content: '' });
  });

  // PUT /api/stickies/:id/blocks/temp — autosave the in-progress comment.
  router.put('/stickies/:id/blocks/temp', (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    const sticky = loadStickyOrFail(req, res, ctx);
    if (!sticky) return;

    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    if (content.length > STICKY_CONTENT_MAX) {
      return res.status(400).json({ error: `content max ${STICKY_CONTENT_MAX} characters` });
    }
    const ok = dbOps.updateTempBlockContent(sticky.id, ctx.userId, content);
    if (!ok) return res.status(404).json({ error: 'No temp block' });
    res.json({ success: true });
  });

  // DELETE /api/stickies/:id/blocks/temp — 取消"再写点".
  router.delete('/stickies/:id/blocks/temp', (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    const sticky = loadStickyOrFail(req, res, ctx);
    if (!sticky) return;
    dbOps.deleteTempBlock(sticky.id, ctx.userId);
    res.json({ success: true });
  });

  // POST /api/stickies/:id/blocks/commit — 先写这么多.
  router.post('/stickies/:id/blocks/commit', async (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    const sticky = loadStickyOrFail(req, res, ctx);
    if (!sticky) return;
    const { content } = req.body || {};
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }
    if (content.length > STICKY_CONTENT_MAX) {
      return res.status(400).json({ error: `content max ${STICKY_CONTENT_MAX} characters` });
    }

    const block = dbOps.commitBlock(sticky.id, ctx.userId, content.trim());
    if (!block) return res.status(404).json({ error: 'No temp block to commit' });

    // Notify the OTHER participant of the sticky. With a 2-person couple
    // that's just `partnerId` regardless of whether commenter is the sticky's
    // original author or the partner — the recipient is "whoever isn't me".
    const partner = dbOps.getUser(ctx.partnerId);
    if (partner && !isUserOnline(ctx.partnerId)) {
      await pushToUser(dbOps, pushFn, ctx.partnerId, 'sticky_appended', ctx.userName);
    }
    emitToCouple(ctx.userId, ctx.partnerId, 'sticky_update', {
      from: ctx.userId,
      kind: 'appended',
      sticky_id: sticky.id,
      block_id: block.id,
    });

    res.json({
      block_id: block.id,
      content: block.content,
      committed_at: block.committed_at,
    });
  });

  // POST /api/stickies/:id/seen — advance my read cursor on this sticky to
  // its current max committed block id. Idempotent + monotonic (the upsert
  // takes MAX, so a stale request can't roll the cursor back).
  router.post('/stickies/:id/seen', (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    const sticky = loadStickyOrFail(req, res, ctx);
    if (!sticky) return;
    const max = dbOps.maxCommittedBlockIdOnSticky(sticky.id);
    dbOps.markStickySeen(ctx.userId, sticky.id, max);
    res.json({ success: true, last_seen_block_id: max });
  });

  // DELETE /api/stickies/:id/blocks/:blockId — 撕掉单条跟帖. Author-only +
  // never the sticky's 原帖 (oldest committed block) — that path goes through
  // tearing the whole sticky. Hard delete; partner sees it disappear via the
  // sticky_update socket below.
  router.delete('/stickies/:id/blocks/:blockId', (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    const sticky = loadStickyOrFail(req, res, ctx);
    if (!sticky) return;
    const blockId = parseId(req.params.blockId as string);
    if (blockId === null) return res.status(400).json({ error: 'Invalid block ID' });

    const result = dbOps.deleteCommittedBlock(sticky.id, blockId, ctx.userId);
    if (!result.ok) {
      if (result.reason === 'first_block') {
        return res.status(400).json({ error: '原帖不能单独撕掉，请整张撕下来' });
      }
      return res.status(404).json({ error: 'Block not found' });
    }

    emitToCouple(ctx.userId, ctx.partnerId, 'sticky_update', {
      from: ctx.userId,
      kind: 'block_deleted',
      sticky_id: sticky.id,
      block_id: blockId,
    });
    res.json({ success: true });
  });

  // DELETE /api/stickies/:id — 撕下来. Either side of the couple can rip a
  // sticky off the wall; this is a hard delete (no trash, no recovery), as
  // intended by spec. Cascades blocks + seen rows in one transaction. The
  // socket update lets the partner's wall refresh immediately.
  router.delete('/stickies/:id', (req: Request, res: Response) => {
    const ctx = requirePair(req, res);
    if (!ctx) return;
    const id = parseId(req.params.id as string);
    if (id === null) return res.status(400).json({ error: 'Invalid ID' });
    const ok = dbOps.deleteSticky(id, ctx.userId, ctx.partnerId);
    if (!ok) return res.status(404).json({ error: 'Sticky not found' });
    emitToCouple(ctx.userId, ctx.partnerId, 'sticky_update', {
      from: ctx.userId,
      kind: 'deleted',
      sticky_id: id,
    });
    res.json({ success: true });
  });

  // POST /api/logout — single-session logout. Drops only the current
  // session's refresh row + device_tokens row, leaves the user's other
  // sessions intact. To kill every session at once (e.g. password
  // reset), POST /api/logout-all instead.
  router.post('/logout', (req: Request, res: Response) => {
    const userId = req.userId!;
    const sessionId = req.sessionId;

    if (sessionId) {
      dbOps.revokeSession(sessionId);
      disconnectSession(sessionId);
      dbOps.promoteFallbackPrimary(userId);
    } else {
      // Legacy access token without sid — fall back to the old behavior.
      // Once all clients refresh post-deploy, this branch is dead.
      dbOps.clearDeviceToken(userId);
      dbOps.deleteAllRefreshTokens(userId);
      dbOps.incrementTokenVersion(userId);
    }

    res.json({ success: true });
  });

  // POST /api/logout-all — explicit "kick every device". Increments
  // token_version so even legacy/sidless tokens die instantly.
  router.post('/logout-all', (req: Request, res: Response) => {
    const userId = req.userId!;
    dbOps.clearDeviceToken(userId);
    dbOps.deleteAllRefreshTokens(userId);
    dbOps.incrementTokenVersion(userId);
    res.json({ success: true });
  });

  // GET /api/sessions — list all active devices for this user.
  router.get('/sessions', (req: Request, res: Response) => {
    const userId = req.userId!;
    const sessions = dbOps.listSessionsForUser(userId, req.sessionId ?? '');
    res.json({ sessions });
  });

  // POST /api/sessions/:sid/primary — promote the named session to
  // primary. Self-promotion always allowed; promoting a non-self session
  // requires the requester to currently be primary (otherwise any device
  // could quietly seize control of the device list).
  router.post('/sessions/:sid/primary', (req: Request, res: Response) => {
    const userId = req.userId!;
    const sid = String(req.params.sid);
    const target = dbOps.getActiveSessionForUser(userId, sid);
    if (!target) return res.status(404).json({ error: 'Session not found' });

    if (sid !== req.sessionId) {
      const me = req.sessionId ? dbOps.getActiveSessionForUser(userId, req.sessionId) : undefined;
      if (!me || me.is_primary !== 1) {
        return res.status(403).json({ error: 'Only the primary device can transfer primary' });
      }
    }
    dbOps.setPrimarySession(userId, sid);
    res.json({ success: true });
  });

  // PUT /api/sessions/:sid/name — rename the device label for the
  // target session. The rename propagates to every other still-active
  // session of this user whose (device_name, device_os) matches the
  // target's, so the device list (which dedups rows by that pair) keeps
  // showing one row per physical device after the edit. Self-rename is
  // always allowed; renaming a non-self session requires primary, same
  // permission model as promote / revoke.
  router.put('/sessions/:sid/name', (req: Request, res: Response) => {
    const userId = req.userId!;
    const sid = String(req.params.sid);
    const raw = (req.body && typeof req.body === 'object') ? (req.body as { name?: unknown }).name : undefined;
    if (typeof raw !== 'string') return res.status(400).json({ error: 'name must be a string' });
    const name = raw.trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (name.length > 80) return res.status(400).json({ error: 'name max 80 characters' });

    const target = dbOps.getActiveSessionForUser(userId, sid);
    if (!target) return res.status(404).json({ error: 'Session not found' });

    if (sid !== req.sessionId) {
      const me = req.sessionId ? dbOps.getActiveSessionForUser(userId, req.sessionId) : undefined;
      if (!me || me.is_primary !== 1) {
        return res.status(403).json({ error: 'Only the primary device can rename other devices' });
      }
    }

    const ok = dbOps.renameSessionGroup(userId, sid, name);
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  });

  // DELETE /api/sessions/:sid/group — force-logout every still-active
  // session of this user that shares the target's (device_name,
  // device_os). Mirrors the dedup grouping the device list does in the
  // app, so "log out this device" wipes every refresh-token row that
  // device left behind across reinstalls. Doing it server-side in a
  // single transaction is required: the previous client-side fan-out
  // raced the auth middleware (own session got revoked first → all
  // sibling DELETEs 401'd → leftover sessions reappeared in the list
  // after re-login under the renamed label).
  router.delete('/sessions/:sid/group', (req: Request, res: Response) => {
    const userId = req.userId!;
    const sid = String(req.params.sid);
    const target = dbOps.getActiveSessionForUser(userId, sid);
    if (!target) return res.status(404).json({ error: 'Session not found' });

    const isSelf = sid === req.sessionId;
    if (!isSelf) {
      const me = req.sessionId ? dbOps.getActiveSessionForUser(userId, req.sessionId) : undefined;
      if (!me || me.is_primary !== 1) {
        return res.status(403).json({ error: 'Only the primary device can sign out other devices' });
      }
    }

    const revokedSids = dbOps.revokeSessionGroup(userId, sid);
    for (const r of revokedSids) {
      disconnectSession(r);
    }
    // If the user just nuked their own primary (directly or because a
    // sibling row in the group held primary), pick a fallback primary
    // so the device list always has someone with kick rights.
    if (isSelf || target.is_primary === 1) {
      dbOps.promoteFallbackPrimary(userId);
    }
    res.json({ success: true, revoked_count: revokedSids.length });
  });

  // DELETE /api/sessions/:sid — force-logout the named session.
  // Self-revoke always allowed; revoking a different session requires
  // the requester to be primary.
  router.delete('/sessions/:sid', (req: Request, res: Response) => {
    const userId = req.userId!;
    const sid = String(req.params.sid);
    const target = dbOps.getActiveSessionForUser(userId, sid);
    if (!target) return res.status(404).json({ error: 'Session not found' });

    const isSelf = sid === req.sessionId;
    if (!isSelf) {
      const me = req.sessionId ? dbOps.getActiveSessionForUser(userId, req.sessionId) : undefined;
      if (!me || me.is_primary !== 1) {
        return res.status(403).json({ error: 'Only the primary device can sign out other devices' });
      }
    }

    const ok = dbOps.revokeSession(sid);
    if (!ok) return res.status(404).json({ error: 'Session already inactive' });
    disconnectSession(sid);
    // If the user just nuked their own primary, promote whoever's next
    // so the device list always has someone with kick rights.
    if (isSelf && target.is_primary === 1) {
      dbOps.promoteFallbackPrimary(userId);
    }
    res.json({ success: true });
  });

  return router;
}

// Default export for backward compatibility
import { dbOps } from './db';
import { sendPush } from './push';

const defaultPublicRouter = createPublicRouter(dbOps);
const defaultProtectedRouter = createProtectedRouter(dbOps, sendPush);
const defaultAuthMiddleware = createAuthMiddleware(dbOps);

export {
  defaultPublicRouter,
  defaultProtectedRouter,
  defaultAuthMiddleware,
};

// Combined default router (used by index.ts)
const combined = Router();
combined.use(defaultPublicRouter);
combined.use(defaultAuthMiddleware, defaultProtectedRouter);
export default combined;
