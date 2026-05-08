import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto, { randomInt } from 'crypto';

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'app.db');

// pair_id charset — 6 letters then 4 digits, all unambiguous (no I/L/O,
// no 0/1) so users reading the code aloud don't trip over look-alikes.
// Total space ≈ 23^6 × 8^4 ≈ 6.0×10^11. With ~10^6 couples, P(collision)
// is < 10^-5; we still guard with a UNIQUE PK + retry loop on insert.
const PAIR_ID_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // 23 chars
const PAIR_ID_DIGITS = '23456789';                 // 8 chars
function generatePairId(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += PAIR_ID_LETTERS[randomInt(PAIR_ID_LETTERS.length)];
  for (let i = 0; i < 4; i++) s += PAIR_ID_DIGITS[randomInt(PAIR_ID_DIGITS.length)];
  return s;
}

// Lex-sorted form of (a, b) — couples.user_a_id is always the smaller id.
function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export interface User {
  id: string;
  name: string;
  password_hash: string;
  partner_id: string | null;
  /** @deprecated Migrated to the `device_tokens` table; do not read at the
   * route layer. The column is kept in `users` only because dropping it in
   * SQLite requires a table rebuild — that cleanup happens in a later
   * commit once everything has been deployed for a release cycle. */
  device_token: string | null;
  pair_code: string;
  token_version: number;
  timezone: string;
  partner_timezone: string;
  partner_remark: string;
  last_read_action_id: number;
  // Marker advanced when the user opens the 发件箱 (OutboxScreen). Any
  // pending letter with created_at > this value is considered "fresh"
  // (drives the 🚩 next to 发件箱 + the 信箱 tab dot). Stored
  // server-side so it survives logout / reinstall / device handoff.
  // SQLite default datetime format ('YYYY-MM-DD HH:MM:SS') so lex
  // comparison against `created_at` of mailbox / time_capsules works.
  outbox_last_seen: string | null;
  created_at: string;
}

// Stable identity for a relationship between two users. The `pair_id` is
// the user-visible 10-char handle (e.g. "KMRPQT4729") that all of the
// couple's data hangs off — when a couple unpairs, ended_at fires the
// 90-day TTL clock; if the same two users re-pair before the timer
// elapses, ended_at is cleared and every row tagged with this pair_id
// becomes visible again.
export interface Couple {
  pair_id: string;
  // Lex-sorted: user_a_id < user_b_id. This is how we look up the row
  // by the unordered pair {a,b} without storing two rows.
  user_a_id: string;
  user_b_id: string;
  started_at: string;
  // NULL = currently active pairing. Non-NULL = unpaired; data is in
  // the 90-day grace window awaiting re-pair or TTL cleanup.
  ended_at: string | null;
}

export interface Action {
  id: number;
  user_id: string;
  user_name: string;
  action_type: string;
  sender_timezone: string;
  reply_to: number | null;
  created_at: string;
}

export interface ImportantDate {
  id: number;
  user_id: string;
  partner_id: string;
  title: string;
  date: string;
  recurring: number;
  pinned: number;
  created_at: string;
}

export interface DailyAnswer {
  id: number;
  user_id: string;
  question_date: string;
  question_index: number;
  answer: string;
  created_at: string;
}

export interface StatsData {
  total_actions: number;
  my_actions: number;
  partner_actions: number;
  top_actions: { action_type: string; count: number }[];
  hourly: { hour: number; count: number }[];
  monthly: { month: string; count: number }[];
  first_action_date: string | null;
}

export interface RefreshToken {
  id: number;
  user_id: string;
  token_hash: string;
  expires_at: string;
  // ISO timestamp set when this token has been rotated. NULL = fresh.
  // The token remains valid for a brief grace window after this is set
  // so a network failure mid-rotate doesn't strand the client.
  superseded_at: string | null;
  created_at: string;
  // The logical session this row belongs to. Multiple non-superseded rows
  // may share a session_id during the 10s rotation grace window; outside
  // that window, exactly one row per (session_id, NULL superseded_at).
  session_id: string;
  device_name: string | null;
  device_model: string | null;
  device_os: string | null;
  app_version: string | null;
  last_active: string | null;
  is_primary: number;
  // Force-logout flips this. Auth middleware rejects access tokens whose
  // sid maps to a revoked row instantly (no waiting for natural expiry).
  revoked: number;
}

// Public-facing session row returned to /api/sessions consumers. Hides
// token_hash + expires_at — clients only need to identify and label.
export interface SessionView {
  session_id: string;
  device_name: string | null;
  device_model: string | null;
  device_os: string | null;
  app_version: string | null;
  last_active: string | null;
  created_at: string;
  is_primary: boolean;
  is_current: boolean;
}

export interface DeviceInfo {
  name?: string | null;
  model?: string | null;
  os?: string | null;
  app_version?: string | null;
}

export interface Ritual {
  id: number;
  user_id: string;
  ritual_type: 'morning' | 'evening';
  ritual_date: string;
  created_at: string;
}

export interface MailboxMessage {
  id: number;
  user_id: string;
  week_key: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface TimeCapsule {
  id: number;
  user_id: string;
  partner_id: string;
  content: string;
  // Date-only field kept for legacy callers + the trash join. New unlock
  // logic uses unlock_at (full ISO with minute precision).
  unlock_date: string;
  // ISO timestamp (UTC) when the capsule becomes unlockable. The sender's
  // chosen local time + their timezone is converted to absolute UTC on the
  // client; the server just stores and compares to NOW().
  unlock_at: string;
  opened_at: string | null;
  visibility: 'self' | 'partner';
  // ISO timestamp when the unlock push was sent. NULL = not yet pushed.
  // Persisted across server restarts so a `pm2 restart` mid-window can't
  // re-send the same notification.
  notified_at: string | null;
  created_at: string;
}

export interface BucketItem {
  id: number;
  user_id: string;
  partner_id: string;
  title: string;
  category: string | null;
  completed: number;
  completed_by: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface DailySnap {
  id: number;
  user_id: string;
  snap_date: string;
  photo_path: string;
  created_at: string;
}

export interface InboxAction {
  id: number;
  user_id: string;
  kind: 'mailbox' | 'capsule';
  ref_id: number;
  status: 'trashed' | 'purged';
  updated_at: string;
}

export interface TrashedInboxItem {
  kind: 'mailbox' | 'capsule';
  ref_id: number;
  // For mailbox: week_key (e.g. "2026-04-27-AM"). For capsule: unlock_date.
  date: string;
  content: string;
  // 'me' if recipient is also the author (only for self-capsule), 'partner'
  // for normal received letters.
  author: 'me' | 'partner';
  // Capsule-only: 'self' | 'partner' visibility. Mailbox is always 'partner'.
  visibility: 'self' | 'partner';
  trashed_at: string;
}

export interface DailyReaction {
  id: number;
  reactor_id: string;
  target_user_id: string;
  target_date: string;
  target_type: 'question' | 'snap';
  reaction: 'up' | 'down';
  created_at: string;
}

// 每日一帖 — 双方共享的便利贴墙。
// sticky_notes 是"一张贴"的元信息（创作者 / 配对快照 / 屏幕坐标 / 时间戳），
// sticky_blocks 是这张贴上所有的"笔触"（初稿 + 后续两人各自'再写点'追加的留言）。
// status='temp' 的 note/block 是用户尚未"贴上去/先写这么多"的临时态，对方完全
// 看不见；只有 status='posted' / 'committed' 才会出现在墙上的最终视图里。
// sticky_seen 是 per-sticky 的"我看到哪一条 block 为止"游标，驱动每张贴右上
// 角的"未读"小灵动岛 + 入口卡的整体小红旗。
export interface StickyNote {
  id: number;
  user_id: string;        // 提笔人 (creator)
  partner_id: string;     // 配对快照，防止 unpair-repair 后串墙
  status: 'temp' | 'posted';
  layout_x: number;       // 0..1 normalized horizontal jitter, 双端共用
  layout_rotation: number; // -8°..+8° tilt, 双端共用
  posted_at: string | null;
  created_at: string;
}

export interface StickyBlock {
  id: number;
  sticky_id: number;
  author_id: string;       // 这一段的提笔人，决定墨水颜色
  content: string;
  status: 'temp' | 'committed';
  committed_at: string | null;
  created_at: string;
  // 每条 block 自己独立成一张便利贴纸渲染时使用的倾角。生成于 commit 一刻，
  // 同一 sticky 下不同 block 各自独立，让叠在一起的几张纸看起来错落有致。
  layout_rotation: number;
}

export interface StickySeen {
  user_id: string;
  sticky_id: number;
  last_seen_block_id: number;
}

export interface DbOps {
  createUser(id: string, name: string, passwordHash: string, pairCode: string, timezone: string): void;
  getUser(id: string): User | undefined;
  getUserByPairCode(pairCode: string): User | undefined;
  pairUsers(userId: string, partnerId: string): void;
  unpairUsers(userId: string, partnerId: string): void;
  // Look up the active pair_id for {a, b}; returns null if not currently
  // paired (the row may exist with ended_at set — that's not active).
  couplesGetActivePairId(userIdA: string, userIdB: string): string | null;
  // Find existing pair (any state) or create a new one. Revives a DORMANT
  // row whose ended_at + 90d > now (clears ended_at). If the row is past
  // TTL, hard-deletes the stale data and creates a fresh pair_id.
  couplesGetOrCreatePair(userIdA: string, userIdB: string): { pair_id: string; revived: boolean };
  // Mark the current active pair as ended; starts the 90-day TTL.
  couplesEndPair(userIdA: string, userIdB: string): void;
  // Atomic combo: "claim a pair_id (creating or reviving)" + "set both
  // users' partner_id pointers". Either both succeed or neither — closes
  // the narrow crash-mid-handler window where couples.ended_at could be
  // cleared but users.partner_id never got set.
  pairCouple(userIdA: string, userIdB: string): { pair_id: string; revived: boolean };
  // Atomic combo: end the couple's pair_id + clear both users'
  // partner_id pointers. Symmetric to pairCouple — couldn't leave the
  // DB in "partner_id still set but ended_at also set" state.
  unpairCouple(userIdA: string, userIdB: string): void;
  // Hard-delete every couples row + all data tagged with that pair_id
  // when the row's ended_at + 90 days have elapsed. Returns the deleted
  // pair_ids for logging / observability.
  couplesCleanupExpired(): string[];
  updatePairCode(userId: string, pairCode: string): void;
  updateProfile(userId: string, name: string, timezone: string, partnerTimezone: string, partnerRemark: string): void;
  setDeviceToken(userId: string, token: string): void;
  clearDeviceToken(userId: string): void;
  clearDeviceTokenByValue(token: string): void;
  // Returns every APNs token currently registered for `userId`. Empty
  // array if the user has no devices registered (push permission denied
  // or app never opened post-install).
  getDeviceTokensForUser(userId: string): string[];
  // Bind an APNs token to a particular session so a /sessions DELETE
  // can drop both atomically. Called right after register/login. No-op
  // if the apns_token row was just deleted by another race.
  attachDeviceTokenToSession(apnsToken: string, sessionId: string): void;
  // Badge / unread tracking — count of partner's actions newer than what this
  // user has marked as read. Used to drive the iOS app icon badge number.
  setLastReadActionId(userId: string, actionId: number): void;
  getUnreadActionCount(userId: string, partnerId: string): number;
  getLatestPartnerActionId(userId: string, partnerId: string): number;
  addAction(userId: string, pairId: string, actionType: string, senderTimezone: string, senderName: string): void;
  getAction(actionId: number): Action | undefined;
  addReaction(userId: string, pairId: string, actionType: string, senderTimezone: string, senderName: string, replyTo: number): number;
  getReaction(actionId: number, userId: string): Action | undefined;
  updateReaction(reactionId: number, actionType: string): void;
  // pair_id-scoped: only returns actions for the requested relationship,
  // so a re-pair after a different intermediate relationship doesn't
  // leak earlier-pair history.
  getHistory(pairId: string, limit: number): Action[];
  // Returns reactions whose reply_to is one of the supplied parent
  // action ids. Empty input → []. Caller (the /api/history route)
  // passes the ids of the actions it just fetched, so the result is
  // aligned with the visible page — no LIMIT cutoff that could drop
  // reactions for older messages once a couple has > 500 reactions.
  getHistoryReactions(pairId: string, parentActionIds: number[]): Action[];
  // Issue a brand-new session at register/login time. Returns the
  // generated session_id and whether this session was made primary
  // (true iff the user had no other primary at the moment of insert —
  // first device automatically claims primary).
  insertRefreshToken(
    userId: string,
    tokenHash: string,
    expiresAt: string,
    sessionId: string,
    deviceInfo?: DeviceInfo,
    isPrimary?: boolean,
  ): void;
  getRefreshToken(tokenHash: string): RefreshToken | undefined;
  deleteRefreshToken(tokenHash: string): void;
  // Rotate by marking the old hash as `superseded_at = now` and inserting
  // a fresh token row that inherits the existing session_id. Within the
  // 10s grace window the old hash stays valid; outside, only the newest
  // row of (session_id, NULL superseded_at) is current. Atomic.
  rotateRefreshToken(
    oldHash: string,
    userId: string,
    newHash: string,
    expiresAt: string,
    sessionId: string,
  ): void;
  // Cleanup: drop expired tokens AND tokens whose grace window has
  // elapsed. Called opportunistically on every rotation; cheap when the
  // table is small.
  pruneRefreshTokens(): void;
  deleteAllRefreshTokens(userId: string): void;
  incrementTokenVersion(userId: string): void;

  // Sessions API.
  // True iff `sessionId` exists, belongs to `userId`, is not revoked,
  // and is not yet expired. Auth middleware calls this on every request
  // so it has to be a single indexed lookup.
  isSessionActive(sessionId: string, userId: string): boolean;
  // Public list of every still-valid session for a user. Filters out
  // superseded (rotated-out) and revoked rows. Order: primary first,
  // then most-recently-active.
  listSessionsForUser(userId: string, currentSessionId: string): SessionView[];
  // Atomically swap primary: only the named session becomes primary,
  // every other session for the user becomes non-primary.
  setPrimarySession(userId: string, sessionId: string): void;
  // Force-logout. Marks the session revoked, drops its device_tokens,
  // returns whether it succeeded (false → session not found / already
  // revoked).
  revokeSession(sessionId: string): boolean;
  // Atomically revoke every still-active session of this user whose
  // (device_name, device_os) matches the target session's, drop their
  // device_tokens, and return the revoked session_ids so callers can
  // disconnect their sockets. Returns [] if the target doesn't exist
  // or doesn't belong to the user.
  revokeSessionGroup(userId: string, sessionId: string): string[];
  // Look up the most recent device_name this user used for the given
  // OS. Returns null if no usable history exists or if the user
  // currently has another active session on that OS (in which case
  // the inherited name might belong to a different physical device).
  inheritDeviceNameForOs(userId: string, deviceOs: string | null): string | null;
  // Rename every active session of this user whose (device_name,
  // device_os) matches the target session's — keeps the dedup group
  // displayed in the app coherent.
  renameSessionGroup(userId: string, sessionId: string, newName: string): boolean;
  // Promote the most-recently-active surviving session to primary if no
  // primary is currently set. Called when the user revokes their own
  // primary session so the user isn't left with no primary.
  promoteFallbackPrimary(userId: string): void;
  // Bump last_active timestamp. Called from the refresh route (every
  // 15min) and on socket connect so the device list shows roughly-
  // current "last active" without per-request write amplification.
  touchSessionLastActive(sessionId: string): void;
  // Returns the session row for a given sid (or undefined). Used by
  // routes to figure out the requester's session_id from JWT sub+sid.
  getSession(sessionId: string): RefreshToken | undefined;
  // Force-logout helper for socket.ts: returns the session_id paired
  // with this access-token's refresh-token row; lets socket auth tag
  // the socket so /sessions/:sid DELETE can drop it instantly.
  getActiveSessionForUser(userId: string, sessionId: string): RefreshToken | undefined;
  getStreak(userId: string, partnerId: string): number;
  createImportantDate(userId: string, partnerId: string, pairId: string, title: string, date: string, recurring: boolean): ImportantDate;
  getImportantDates(pairId: string): ImportantDate[];
  updateImportantDate(id: number, title: string, date: string, recurring: boolean, pairId: string): boolean;
  deleteImportantDate(id: number, pairId: string): boolean;
  pinImportantDate(id: number, pairId: string): void;
  submitDailyAnswer(userId: string, pairId: string, questionDate: string, questionIndex: number, answer: string): void;
  getDailyAnswers(questionDate: string, pairId: string, userId: string): { mine?: DailyAnswer; partner?: DailyAnswer };
  getQuestionAssignment(pairId: string, questionDate: string): number | null;
  setQuestionAssignment(pairId: string, questionDate: string, questionIndex: number): void;
  getCompletedQuestionIndexes(pairId: string): Set<number>;
  getStats(pairId: string, userId: string): StatsData;
  // Rituals
  submitRitual(userId: string, ritualType: 'morning' | 'evening', ritualDate: string): boolean;
  getRituals(ritualDate: string, userId: string, partnerId: string): Ritual[];
  getRitualsByDates(myDate: string, partnerDate: string, userId: string, partnerId: string): { myMorning: boolean; myEvening: boolean; partnerMorning: boolean; partnerEvening: boolean };
  // Range is two UTC ISO instants — the route layer computes them from the
  // user's tz so the recap counts the right local-day window.
  getDailyRecap(userId: string, partnerId: string, startUtcIso: string, endUtcIso: string): { total_interactions: number; top_action: string | null };
  // Mailbox
  submitMailboxMessage(userId: string, pairId: string, weekKey: string, content: string): boolean;
  getMailboxMessages(weekKey: string, pairId: string, userId: string): { mine?: MailboxMessage; partner?: MailboxMessage };
  // Per-letter archive — each row is one partner-authored mailbox letter
  // visible to `userId` within the current pair_id. `my_content` is
  // always null; the sender uses the dedicated outbox endpoint to see
  // their own pending mail.
  getMailboxArchive(userId: string, pairId: string, partnerId: string, limit: number): { week_key: string; my_content: string | null; partner_content: string | null; partner_message_id: number | null; partner_created_at: string | null }[];
  // Outbox: my mailbox letters in a single session (typically the current
  // session, before reveal), scoped to the current pair_id.
  getMyMailboxInSession(userId: string, pairId: string, weekKey: string): { id: number; week_key: string; content: string; created_at: string }[];
  // Advance the user's outbox-last-seen marker to "now". Drives the 🚩
  // freshness check against pending letters' created_at. Stored
  // server-side so the marker survives logout / reinstall / device hop.
  markOutboxSeen(userId: string): void;

  // Step 4: cross-device sync for what used to be AsyncStorage-only
  // state. All three live on `users` for simplicity (one row per user
  // already, single source of truth, no extra joins on hot paths).
  getDailySeen(userId: string): { date: string | null; pa: boolean; ps: boolean };
  setDailySeen(userId: string, date: string, pa: boolean, ps: boolean): void;
  getInboxLastSeen(userId: string): string | null;
  setInboxLastSeen(userId: string, iso: string): void;
  getLetterDraft(userId: string): string;
  setLetterDraft(userId: string, draft: string): void;
  getAllPairedUserTokens(): { device_token: string }[];
  // Same shape as the broadcast-tokens query but at user granularity, so
  // scheduler broadcasts can fan out via pushToUser (which fills in the
  // APNs badge per recipient) instead of bypassing it with raw sendPush.
  getAllPairedUserIds(): string[];
  // Cross-feature unread total used as the default APNs badge when a
  // pushToUser caller doesn't supply one. Sums History + Inbox letters
  // (mailbox + unlocked partner-bound capsules) + sticky-wall blocks.
  // Daily-question/snap unread is NOT included — its "today" boundary
  // depends on the user's local-date logic that lives at the route layer;
  // pushToUser's `Math.max(1, …)` floor still guarantees daily pushes
  // surface a red badge even when total is 0.
  getTotalUnreadBadge(userId: string): number;
  // Weekly Report.
  //   weekStart/weekEnd  — date-only YYYY-MM-DD strings (used for the
  //     question_date / ritual_date comparisons; those columns are stored
  //     as date-only already).
  //   actionsStart/actionsEnd — the SAME local-midnight boundaries
  //     converted to SQLite-format UTC strings ('YYYY-MM-DD HH:MM:SS').
  //     Used for `created_at` comparisons in the actions table so a NY
  //     user's "this week" lines up with their wall-clock Monday-Sunday
  //     instead of UTC's.
  getWeeklyReportData(
    userId: string, partnerId: string,
    weekStart: string, weekEnd: string,
    actionsStart: string, actionsEnd: string,
  ): {
    total: number; lastWeekTotal: number; myCount: number; partnerCount: number;
    topActions: { action_type: string; count: number }[];
    dailyQuestionDays: number; ritualMorningDays: number; ritualEveningDays: number;
  };
  // Time Capsules
  createCapsule(userId: string, partnerId: string, pairId: string, content: string, unlockDate: string, unlockAt: string, visibility: 'self' | 'partner'): TimeCapsule;
  getCapsules(pairId: string): TimeCapsule[];
  openCapsule(id: number): boolean;
  // `nowIso` is the cutoff: any capsule with unlock_at <= nowIso, not yet
  // opened, and not yet notified is due for a push.
  getUnlockableCapsules(nowIso: string): TimeCapsule[];
  // Mark a batch of capsules as "notification already sent" so a server
  // restart mid-window doesn't re-push. Persists the dedup state.
  markCapsulesNotified(capsuleIds: number[], nowIso: string): void;
  // Bucket List
  createBucketItem(userId: string, partnerId: string, pairId: string, title: string, category: string | null): BucketItem;
  getBucketItems(pairId: string): BucketItem[];
  completeBucketItem(id: number, userId: string): boolean;
  uncompleteBucketItem(id: number): boolean;
  deleteBucketItem(id: number, userId: string, partnerId: string): boolean;
  // Daily Snaps
  saveSnap(userId: string, snapDate: string, photoPath: string): boolean;
  // Atomic INSERT OR IGNORE + read partner's snap inside one transaction.
  // Returns saved=false when the user has already snapped today (so the
  // route can short-circuit with a clear error before touching the file
  // system). Closes the double-click race where two parallel uploads
  // could both pass a pre-INSERT check and end up with one user's tmp
  // overwriting the other's finalPath.
  saveSnapAtomic(userId: string, partnerId: string, snapDate: string, photoPath: string): { saved: boolean; bothSnapped: boolean };
  // Used to roll back the saveSnapAtomic row when the subsequent file
  // rename fails (disk full / permission denied) so the user can retry
  // without being permanently locked out by a phantom DB row pointing
  // to a non-existent file.
  deleteSnap(userId: string, snapDate: string): void;
  getSnap(userId: string, snapDate: string): DailySnap | undefined;
  getSnaps(userId: string, partnerId: string, month: string): { snap_date: string; user_photo: string | null; partner_photo: string | null }[];
  // Daily Reactions (👍/👎 on partner's daily question answer or daily snap)
  setDailyReaction(reactorId: string, targetUserId: string, pairId: string, targetDate: string, targetType: 'question' | 'snap', reaction: 'up' | 'down'): void;
  // Inbox actions — per-recipient soft delete state for mailbox/capsule.
  setInboxAction(userId: string, pairId: string, kind: 'mailbox' | 'capsule', refId: number, status: 'trashed' | 'purged'): void;
  clearInboxAction(userId: string, kind: 'mailbox' | 'capsule', refId: number): void;
  getInboxActionStatus(userId: string, kind: 'mailbox' | 'capsule', refId: number): 'trashed' | 'purged' | null;
  getTrashedInboxItems(userId: string, partnerId: string): TrashedInboxItem[];
  getMailboxMessageById(id: number): MailboxMessage | undefined;
  getCapsuleById(id: number): TimeCapsule | undefined;
  getDailyReaction(reactorId: string, targetUserId: string, targetDate: string, targetType: 'question' | 'snap'): 'up' | 'down' | null;
  // Sticky notes (每日一帖)
  getTempSticky(userId: string): StickyNote | undefined;
  createTempSticky(userId: string, partnerId: string, pairId: string): { sticky: StickyNote; block: StickyBlock };
  updateTempStickyContent(userId: string, content: string): boolean;
  deleteTempSticky(userId: string): boolean;
  postSticky(userId: string, content: string, layoutX: number, layoutRotation: number): { sticky: StickyNote; block: StickyBlock } | null;
  getStickyForCouple(stickyId: number, pairId: string): StickyNote | undefined;
  listWallStickies(pairId: string, limit: number): StickyNote[];
  listCommittedBlocksForStickies(stickyIds: number[]): StickyBlock[];
  listSeenForStickies(userId: string, stickyIds: number[]): Map<number, number>;
  maxCommittedBlockIdOnSticky(stickyId: number): number;
  getTempBlock(stickyId: number, authorId: string): StickyBlock | undefined;
  createTempBlock(stickyId: number, authorId: string): StickyBlock;
  updateTempBlockContent(stickyId: number, authorId: string, content: string): boolean;
  deleteTempBlock(stickyId: number, authorId: string): boolean;
  commitBlock(stickyId: number, authorId: string, content: string): StickyBlock | null;
  markStickySeen(userId: string, stickyId: number, blockId: number): void;
  // Permanently rip a posted sticky off the wall. Cascades through blocks +
  // per-recipient seen rows. Either side of the couple can tear; the route
  // checks couple membership upstream.
  deleteSticky(stickyId: number, userId: string, partnerId: string): boolean;
  // Delete a single committed comment block. Restricted to the block's own
  // author and never the sticky's first (oldest) committed block — the spec
  // forbids removing the original post via the per-block path; users have to
  // tear the whole sticky for that.
  deleteCommittedBlock(stickyId: number, blockId: number, authorId: string): { ok: boolean; reason?: 'not_found' | 'first_block' };
}

// One-shot D+ backfill — wrapped in a single OUTER transaction so a
// process kill mid-migration rolls everything back; next boot retries
// from scratch (couples table is still empty, so the gate at the top of
// createDatabase fires again). Without this wrap, a partial migration
// would leave the couples table half-populated, fail the empty check,
// and silently skip the rest of the backfill forever.
function runPairIdBackfill(db: DatabaseType): void {
  db.transaction(() => _backfillBody(db))();
}

// Internal: the actual backfill steps. Always called inside a tx.
//   1. ACTIVE pairs: read from users.partner_id; one couples row per
//      currently-paired (a, b); UPDATE all matching data rows.
//   2. HISTORICAL pairs reconstructable from rows that carry both
//      user_id + partner_id (capsules / sticky_notes / bucket_items /
//      daily_reactions / important_dates). For each unique (a, b) tuple
//      not already an active pair, synthesize a couples row with
//      ended_at = now (TTL clock starts on migration day; that's the
//      one accepted migration imperfection).
//   3. USER-ID-ONLY tables (actions / mailbox / daily_answers): time-
//      bucket attribution. For each row, find the couple whose data
//      window [min(created_at), max(created_at)] (computed from
//      partner_id-bearing tables) contains the row's created_at.
//   4. ORPHANS we still can't attribute → hard delete.
function _backfillBody(db: DatabaseType): void {
  const insertCouple = db.prepare(
    'INSERT OR IGNORE INTO couples (pair_id, user_a_id, user_b_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?)'
  );
  const couplesByUsers = db.prepare(
    'SELECT pair_id FROM couples WHERE user_a_id = ? AND user_b_id = ?'
  );
  function freshPairId(): string {
    for (let i = 0; i < 16; i++) {
      const candidate = generatePairId();
      const taken = db.prepare('SELECT 1 FROM couples WHERE pair_id = ?').get(candidate);
      if (!taken) return candidate;
    }
    throw new Error('pair_id collision storm during backfill');
  }
  function getOrCreateCouple(a: string, b: string, ended: string | null): string {
    const [u, v] = sortedPair(a, b);
    const existing = couplesByUsers.get(u, v) as { pair_id: string } | undefined;
    if (existing) return existing.pair_id;
    const pid = freshPairId();
    insertCouple.run(pid, u, v, new Date().toISOString().slice(0, 19).replace('T', ' '), ended);
    return pid;
  }

  // Phase 1: Active pairs. users.partner_id is bidirectional once paired,
  // so we collect each couple by lex-sorting and deduping.
  const pairedUsers = db.prepare(
    "SELECT id, partner_id FROM users WHERE partner_id IS NOT NULL"
  ).all() as { id: string; partner_id: string }[];
  const activePairs = new Set<string>();
  const activePairMap = new Map<string, string>(); // key="a:b" → pair_id
  db.transaction(() => {
    for (const u of pairedUsers) {
      const [a, b] = sortedPair(u.id, u.partner_id);
      const key = `${a}:${b}`;
      if (activePairs.has(key)) continue;
      activePairs.add(key);
      const pid = getOrCreateCouple(a, b, null);
      activePairMap.set(key, pid);
    }
  })();

  // Phase 2: Historical pairs from tables with explicit (user_id, partner_id).
  const historicalPairsSql: { table: string; sql: string }[] = [
    { table: 'time_capsules',  sql: 'SELECT DISTINCT user_id, partner_id FROM time_capsules' },
    { table: 'sticky_notes',   sql: 'SELECT DISTINCT user_id, partner_id FROM sticky_notes' },
    { table: 'bucket_items',   sql: 'SELECT DISTINCT user_id, partner_id FROM bucket_items' },
    { table: 'important_dates',sql: 'SELECT DISTINCT user_id, partner_id FROM important_dates' },
  ];
  db.transaction(() => {
    const nowSqlite = new Date().toISOString().slice(0, 19).replace('T', ' ');
    for (const q of historicalPairsSql) {
      const rows = db.prepare(q.sql).all() as { user_id: string; partner_id: string }[];
      for (const r of rows) {
        if (!r.partner_id) continue;
        const [a, b] = sortedPair(r.user_id, r.partner_id);
        const key = `${a}:${b}`;
        if (activePairs.has(key)) continue;
        // Synthesize DORMANT couple row.
        getOrCreateCouple(a, b, nowSqlite);
      }
    }
    // daily_reactions encodes (reactor, target) — same pair semantics.
    const reactRows = db.prepare(
      'SELECT DISTINCT reactor_id, target_user_id FROM daily_reactions'
    ).all() as { reactor_id: string; target_user_id: string }[];
    for (const r of reactRows) {
      const [a, b] = sortedPair(r.reactor_id, r.target_user_id);
      const key = `${a}:${b}`;
      if (activePairs.has(key)) continue;
      getOrCreateCouple(a, b, nowSqlite);
    }
  })();

  // Phase 2b: tag rows in tables-with-partner_id by their own (user_id, partner_id).
  db.transaction(() => {
    db.exec(`
      UPDATE time_capsules SET pair_id = (
        SELECT pair_id FROM couples
        WHERE (user_a_id = MIN(time_capsules.user_id, time_capsules.partner_id)
           AND user_b_id = MAX(time_capsules.user_id, time_capsules.partner_id))
      ) WHERE pair_id IS NULL;
      UPDATE sticky_notes SET pair_id = (
        SELECT pair_id FROM couples
        WHERE (user_a_id = MIN(sticky_notes.user_id, sticky_notes.partner_id)
           AND user_b_id = MAX(sticky_notes.user_id, sticky_notes.partner_id))
      ) WHERE pair_id IS NULL;
      UPDATE bucket_items SET pair_id = (
        SELECT pair_id FROM couples
        WHERE (user_a_id = MIN(bucket_items.user_id, bucket_items.partner_id)
           AND user_b_id = MAX(bucket_items.user_id, bucket_items.partner_id))
      ) WHERE pair_id IS NULL;
      UPDATE important_dates SET pair_id = (
        SELECT pair_id FROM couples
        WHERE (user_a_id = MIN(important_dates.user_id, important_dates.partner_id)
           AND user_b_id = MAX(important_dates.user_id, important_dates.partner_id))
      ) WHERE pair_id IS NULL;
      UPDATE daily_reactions SET pair_id = (
        SELECT pair_id FROM couples
        WHERE (user_a_id = MIN(daily_reactions.reactor_id, daily_reactions.target_user_id)
           AND user_b_id = MAX(daily_reactions.reactor_id, daily_reactions.target_user_id))
      ) WHERE pair_id IS NULL;
    `);
  })();

  // Phase 3: time-bucket attribution for user-id-only tables.
  // Build per-user [pair_id, min_dt, max_dt] windows from already-tagged
  // rows (capsules, stickies, buckets, dates, reactions). Then walk
  // actions / mailbox / daily_answers and pick the window each row's
  // created_at falls into.
  type Window = { pair_id: string; min_dt: string; max_dt: string };
  const windowsByUser = new Map<string, Window[]>();
  const winRows = db.prepare(`
    SELECT user_id, pair_id, MIN(created_at) AS min_dt, MAX(created_at) AS max_dt FROM (
      SELECT user_id, pair_id, created_at FROM time_capsules WHERE pair_id IS NOT NULL
      UNION ALL
      SELECT partner_id AS user_id, pair_id, created_at FROM time_capsules WHERE pair_id IS NOT NULL
      UNION ALL
      SELECT user_id, pair_id, created_at FROM sticky_notes WHERE pair_id IS NOT NULL
      UNION ALL
      SELECT partner_id AS user_id, pair_id, created_at FROM sticky_notes WHERE pair_id IS NOT NULL
      UNION ALL
      SELECT user_id, pair_id, created_at FROM bucket_items WHERE pair_id IS NOT NULL
      UNION ALL
      SELECT partner_id AS user_id, pair_id, created_at FROM bucket_items WHERE pair_id IS NOT NULL
      UNION ALL
      SELECT user_id, pair_id, created_at FROM important_dates WHERE pair_id IS NOT NULL
      UNION ALL
      SELECT partner_id AS user_id, pair_id, created_at FROM important_dates WHERE pair_id IS NOT NULL
      UNION ALL
      SELECT reactor_id AS user_id, pair_id, created_at FROM daily_reactions WHERE pair_id IS NOT NULL
      UNION ALL
      SELECT target_user_id AS user_id, pair_id, created_at FROM daily_reactions WHERE pair_id IS NOT NULL
    )
    GROUP BY user_id, pair_id
  `).all() as { user_id: string; pair_id: string; min_dt: string; max_dt: string }[];
  for (const r of winRows) {
    const arr = windowsByUser.get(r.user_id) ?? [];
    arr.push({ pair_id: r.pair_id, min_dt: r.min_dt, max_dt: r.max_dt });
    windowsByUser.set(r.user_id, arr);
  }

  // For currently-paired users, fall through to their active pair_id when
  // no window matches (fallback).
  const userActivePair = new Map<string, string>();
  for (const u of pairedUsers) {
    const [a, b] = sortedPair(u.id, u.partner_id);
    const pid = activePairMap.get(`${a}:${b}`);
    if (pid) userActivePair.set(u.id, pid);
  }

  function attributeRow(userId: string, createdAt: string): string | null {
    const windows = windowsByUser.get(userId);
    if (!windows || windows.length === 0) {
      return userActivePair.get(userId) ?? null;
    }
    // Find window containing createdAt
    for (const w of windows) {
      if (createdAt >= w.min_dt && createdAt <= w.max_dt) return w.pair_id;
    }
    // No exact containment — pick nearest by min_dt distance
    let best: Window | null = null;
    let bestDist = Infinity;
    for (const w of windows) {
      const dist = createdAt < w.min_dt
        ? Date.parse(w.min_dt + 'Z') - Date.parse(createdAt + 'Z')
        : Date.parse(createdAt + 'Z') - Date.parse(w.max_dt + 'Z');
      if (dist < bestDist) { bestDist = dist; best = w; }
    }
    if (best) return best.pair_id;
    return userActivePair.get(userId) ?? null;
  }

  db.transaction(() => {
    const tagOne = (table: string, idCol: string, userCol: string) => {
      const updateStmt = db.prepare(`UPDATE ${table} SET pair_id = ? WHERE ${idCol} = ?`);
      const deleteStmt = db.prepare(`DELETE FROM ${table} WHERE ${idCol} = ?`);
      const rows = db.prepare(
        `SELECT ${idCol} AS id, ${userCol} AS uid, created_at FROM ${table} WHERE pair_id IS NULL`
      ).all() as { id: number; uid: string; created_at: string }[];
      let tagged = 0; let dropped = 0;
      for (const r of rows) {
        const pid = attributeRow(r.uid, r.created_at);
        if (pid) { updateStmt.run(pid, r.id); tagged++; }
        else { deleteStmt.run(r.id); dropped++; }
      }
      if (tagged || dropped) console.log(`[Backfill] ${table}: tagged ${tagged}, dropped ${dropped}`);
    };
    tagOne('actions', 'id', 'user_id');
    tagOne('mailbox', 'id', 'user_id');
    tagOne('daily_answers', 'id', 'user_id');
  })();

  // Phase 4: inbox_actions tag from referenced row's pair_id.
  db.transaction(() => {
    db.exec(`
      UPDATE inbox_actions SET pair_id = (
        SELECT m.pair_id FROM mailbox m WHERE m.id = inbox_actions.ref_id
      ) WHERE pair_id IS NULL AND kind = 'mailbox';
      UPDATE inbox_actions SET pair_id = (
        SELECT c.pair_id FROM time_capsules c WHERE c.id = inbox_actions.ref_id
      ) WHERE pair_id IS NULL AND kind = 'capsule';
      DELETE FROM inbox_actions WHERE pair_id IS NULL;
    `);
  })();

  // Phase 5: daily_question_assignments — re-seed today's question per
  // currently-active couple from the snapshot we took during the table
  // rebuild, so users who already answered today's question see the
  // matching prompt. New days get re-randomized per couple via the
  // route's lazy assignment.
  const snap = (db as any).__migrationDqaSnapshot as { question_date: string; question_index: number } | undefined;
  if (snap && activePairMap.size > 0) {
    const insAssign = db.prepare(
      'INSERT OR IGNORE INTO daily_question_assignments (pair_id, question_date, question_index) VALUES (?, ?, ?)'
    );
    db.transaction(() => {
      for (const pid of activePairMap.values()) {
        insAssign.run(pid, snap.question_date, snap.question_index);
      }
    })();
    delete (db as any).__migrationDqaSnapshot;
  }

  // Phase 6: drop any remaining un-attributed orphans in user-id-only
  // tables. After phase 3 these should be ~zero, but a tiny number of
  // extreme-edge rows can survive (e.g., user with NO data in any
  // partner_id-table whatsoever). Hard-delete satisfies the "no NULL
  // pair_id rows survive migration" requirement.
  db.transaction(() => {
    db.exec(`
      DELETE FROM actions WHERE pair_id IS NULL;
      DELETE FROM mailbox WHERE pair_id IS NULL;
      DELETE FROM daily_answers WHERE pair_id IS NULL;
      DELETE FROM time_capsules WHERE pair_id IS NULL;
      DELETE FROM sticky_notes WHERE pair_id IS NULL;
      DELETE FROM bucket_items WHERE pair_id IS NULL;
      DELETE FROM important_dates WHERE pair_id IS NULL;
      DELETE FROM daily_reactions WHERE pair_id IS NULL;
      DELETE FROM inbox_actions WHERE pair_id IS NULL;
    `);
  })();
}

export function createDatabase(dbPath?: string): { db: DatabaseType; dbOps: DbOps } {
  const resolvedPath = dbPath || DEFAULT_DB_PATH;

  // Ensure parent directory exists for file-based databases
  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolvedPath);

  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      partner_id TEXT,
      device_token TEXT,
      pair_code TEXT UNIQUE,
      token_version INTEGER NOT NULL DEFAULT 1,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      partner_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      partner_remark TEXT NOT NULL DEFAULT '',
      last_read_action_id INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (partner_id) REFERENCES users(id)
    );

    -- Stable identity for each historical (and current) relationship
    -- between two users. The pair_id is a 10-char user-facing handle
    -- (6 letters + 4 digits, like KMRPQT4729). Every couple-scoped row
    -- in the system is keyed off this id; when ended_at fires, that row
    -- (and all data tagged with this pair_id) lives in a 90-day grace
    -- window. Re-pairing the same two users clears ended_at and the
    -- data resurfaces as if nothing happened.
    CREATE TABLE IF NOT EXISTS couples (
      pair_id TEXT PRIMARY KEY,
      user_a_id TEXT NOT NULL,
      user_b_id TEXT NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME DEFAULT NULL,
      FOREIGN KEY (user_a_id) REFERENCES users(id),
      FOREIGN KEY (user_b_id) REFERENCES users(id),
      UNIQUE(user_a_id, user_b_id),
      CHECK(user_a_id < user_b_id)
    );

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      pair_id TEXT,
      action_type TEXT NOT NULL,
      sender_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      sender_name TEXT NOT NULL DEFAULT '',
      reply_to INTEGER REFERENCES actions(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      -- When this token was rotated. Within a brief grace window after
      -- rotation the same token is still accepted (so a network glitch
      -- mid-rotate doesn't lock the user out — they'll just receive a new
      -- pair on the retry). NULL means the token has not been rotated yet.
      superseded_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- One row per (user, physical device) APNs token. Replaces the old
    -- single-valued users.device_token column so a user signed in on
    -- several phones can receive pushes on all of them. session_id is
    -- nullable until Step 3 wires sessions in; APNs tokens registered
    -- before sessions exist won't bind to one.
    CREATE TABLE IF NOT EXISTS device_tokens (
      apns_token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS important_dates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      partner_id TEXT NOT NULL,
      pair_id TEXT,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      recurring INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- daily_question_assignments — keyed by (pair_id, question_date) so
    -- each couple gets their OWN question per day (different couples
    -- cannot accidentally share a question, and a couple's "no repeat"
    -- promise actually holds).
    CREATE TABLE IF NOT EXISTS daily_question_assignments (
      pair_id TEXT NOT NULL,
      question_date TEXT NOT NULL,
      question_index INTEGER NOT NULL,
      PRIMARY KEY (pair_id, question_date)
    );

    CREATE TABLE IF NOT EXISTS daily_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      pair_id TEXT,
      question_date TEXT NOT NULL,
      question_index INTEGER NOT NULL,
      answer TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, question_date)
    );

    CREATE TABLE IF NOT EXISTS rituals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ritual_type TEXT NOT NULL CHECK(ritual_type IN ('morning', 'evening')),
      ritual_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, ritual_type, ritual_date)
    );

    -- Multi-letter mailbox: per session, both users may submit any number
    -- of letters, all sealed at insert and revealed at the next session
    -- boundary together. (No UNIQUE on (user_id, week_key) — see the
    -- corresponding migration block below for the legacy-DB rebuild path.)
    CREATE TABLE IF NOT EXISTS mailbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      pair_id TEXT,
      week_key TEXT NOT NULL,
      content TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mailbox_user_week ON mailbox(user_id, week_key);
    CREATE INDEX IF NOT EXISTS idx_mailbox_week_created ON mailbox(week_key, created_at);

    CREATE TABLE IF NOT EXISTS time_capsules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      partner_id TEXT NOT NULL,
      pair_id TEXT,
      content TEXT NOT NULL,
      unlock_date TEXT NOT NULL,
      unlock_at TEXT NOT NULL DEFAULT '',
      opened_at DATETIME DEFAULT NULL,
      visibility TEXT NOT NULL DEFAULT 'partner',
      notified_at TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS bucket_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      partner_id TEXT NOT NULL,
      pair_id TEXT,
      title TEXT NOT NULL,
      category TEXT DEFAULT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_by TEXT DEFAULT NULL,
      completed_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS daily_snaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      snap_date TEXT NOT NULL,
      photo_path TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, snap_date)
    );

    CREATE TABLE IF NOT EXISTS daily_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reactor_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      pair_id TEXT,
      target_date TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('question', 'snap')),
      reaction TEXT NOT NULL CHECK(reaction IN ('up', 'down')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (reactor_id) REFERENCES users(id),
      FOREIGN KEY (target_user_id) REFERENCES users(id),
      UNIQUE(reactor_id, target_user_id, target_date, target_type)
    );

    -- inbox_actions: per-recipient soft delete state for mailbox/capsule
    -- letters. status='trashed' (in trash, can restore) or 'purged' (forever
    -- hidden from recipient — source row may still exist for the sender).
    CREATE TABLE IF NOT EXISTS inbox_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      pair_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('mailbox', 'capsule')),
      ref_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('trashed', 'purged')),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, kind, ref_id)
    );

    -- 每日一帖 — see StickyNote/StickyBlock/StickySeen interfaces above for the
    -- temp/posted lifecycle. layout_x/layout_rotation are computed on post and
    -- shared across both clients so the wall renders identically on both sides.
    CREATE TABLE IF NOT EXISTS sticky_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      partner_id TEXT NOT NULL,
      pair_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('temp', 'posted')),
      layout_x REAL NOT NULL DEFAULT 0,
      layout_rotation REAL NOT NULL DEFAULT 0,
      posted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sticky_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sticky_id INTEGER NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('temp', 'committed')),
      committed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sticky_id) REFERENCES sticky_notes(id),
      FOREIGN KEY (author_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sticky_seen (
      user_id TEXT NOT NULL,
      sticky_id INTEGER NOT NULL,
      last_seen_block_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, sticky_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (sticky_id) REFERENCES sticky_notes(id)
    );

    CREATE INDEX IF NOT EXISTS idx_actions_time ON actions(created_at DESC);
    -- /api/history filters by pair_id and orders by created_at DESC. Without
    -- this composite the planner has to scan idx_actions_time and re-filter
    -- by pair_id, which degrades visibly once a couple's history grows past
    -- ~10k rows. The DESC order match means the planner can serve the page
    -- straight off the index without an explicit sort step.
    CREATE INDEX IF NOT EXISTS idx_actions_pair_time ON actions(pair_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_device_tokens_session ON device_tokens(session_id);
    CREATE INDEX IF NOT EXISTS idx_rituals_user_date ON rituals(user_id, ritual_date);
    CREATE INDEX IF NOT EXISTS idx_mailbox_week ON mailbox(week_key);
    CREATE INDEX IF NOT EXISTS idx_capsules_unlock ON time_capsules(unlock_date);
    -- Scheduler scans unlock_at + opened_at + notified_at every 5 min;
    -- without this index that turns into a full table scan.
    CREATE INDEX IF NOT EXISTS idx_capsules_unlock_at ON time_capsules(unlock_at);
    CREATE INDEX IF NOT EXISTS idx_bucket_couple ON bucket_items(user_id, partner_id);
    CREATE INDEX IF NOT EXISTS idx_snaps_date ON daily_snaps(snap_date);
    CREATE INDEX IF NOT EXISTS idx_daily_reactions_lookup ON daily_reactions(reactor_id, target_user_id, target_date, target_type);
    CREATE INDEX IF NOT EXISTS idx_inbox_actions_user ON inbox_actions(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_inbox_actions_ref ON inbox_actions(kind, ref_id);
    CREATE INDEX IF NOT EXISTS idx_sticky_couple_status ON sticky_notes(user_id, partner_id, status);
    CREATE INDEX IF NOT EXISTS idx_sticky_blocks_sticky ON sticky_blocks(sticky_id);
    CREATE INDEX IF NOT EXISTS idx_sticky_blocks_author_status ON sticky_blocks(sticky_id, author_id, status);

  `);

  // Migrations for existing databases
  const userCols = db.pragma('table_info(users)') as { name: string }[];
  if (!userCols.some((c) => c.name === 'password_hash')) {
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''");
  }
  if (!userCols.some((c) => c.name === 'token_version')) {
    db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1');
  }
  if (!userCols.some((c) => c.name === 'timezone')) {
    db.exec("ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'");
  }
  if (!userCols.some((c) => c.name === 'partner_timezone')) {
    db.exec("ALTER TABLE users ADD COLUMN partner_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'");
  }
  if (!userCols.some((c) => c.name === 'partner_remark')) {
    db.exec("ALTER TABLE users ADD COLUMN partner_remark TEXT NOT NULL DEFAULT ''");
  }
  if (!userCols.some((c) => c.name === 'last_read_action_id')) {
    db.exec('ALTER TABLE users ADD COLUMN last_read_action_id INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.some((c) => c.name === 'outbox_last_seen')) {
    db.exec('ALTER TABLE users ADD COLUMN outbox_last_seen TEXT DEFAULT NULL');
  }
  // Step 4: per-user "I have seen" markers and the in-progress letter
  // draft live on the server so they sync across devices for the same
  // account. Each device used to keep these in AsyncStorage, which broke
  // the "log in on a second phone, see all my state" promise.
  if (!userCols.some((c) => c.name === 'daily_seen_date')) {
    db.exec('ALTER TABLE users ADD COLUMN daily_seen_date TEXT');
  }
  if (!userCols.some((c) => c.name === 'daily_seen_pa')) {
    db.exec('ALTER TABLE users ADD COLUMN daily_seen_pa INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.some((c) => c.name === 'daily_seen_ps')) {
    db.exec('ALTER TABLE users ADD COLUMN daily_seen_ps INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.some((c) => c.name === 'inbox_last_seen')) {
    db.exec('ALTER TABLE users ADD COLUMN inbox_last_seen TEXT');
  }
  if (!userCols.some((c) => c.name === 'write_letter_draft')) {
    db.exec("ALTER TABLE users ADD COLUMN write_letter_draft TEXT NOT NULL DEFAULT ''");
  }

  const actionCols = db.pragma('table_info(actions)') as { name: string }[];
  if (!actionCols.some((c) => c.name === 'sender_timezone')) {
    db.exec("ALTER TABLE actions ADD COLUMN sender_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'");
  }
  if (!actionCols.some((c) => c.name === 'sender_name')) {
    db.exec("ALTER TABLE actions ADD COLUMN sender_name TEXT NOT NULL DEFAULT ''");
  }
  if (!actionCols.some((c) => c.name === 'reply_to')) {
    db.exec('ALTER TABLE actions ADD COLUMN reply_to INTEGER REFERENCES actions(id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_actions_reply_to ON actions(reply_to)');
  }

  // Migration: remove CHECK constraint on action_type (to support new types)
  const tableDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='actions'").get() as { sql: string } | undefined;
  if (tableDef?.sql.includes('CHECK(action_type IN')) {
    db.exec(`
      CREATE TABLE actions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        sender_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        sender_name TEXT NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT INTO actions_new SELECT id, user_id, action_type, sender_timezone, sender_name, created_at FROM actions;
      DROP TABLE actions;
      ALTER TABLE actions_new RENAME TO actions;
      CREATE INDEX IF NOT EXISTS idx_actions_time ON actions(created_at DESC);
    `);
  }

  // Migration: add pinned column to important_dates
  const dateCols = db.pragma('table_info(important_dates)') as { name: string }[];
  if (dateCols.length > 0 && !dateCols.some((c) => c.name === 'pinned')) {
    db.exec('ALTER TABLE important_dates ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }

  // Migration: add locked column to mailbox; lock all pre-existing rows so they become read-only
  const mailboxCols = db.pragma('table_info(mailbox)') as { name: string }[];
  if (mailboxCols.length > 0 && !mailboxCols.some((c) => c.name === 'locked')) {
    db.exec('ALTER TABLE mailbox ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE mailbox SET locked = 1');
  }

  // Migration: add superseded_at to refresh_tokens for the rotation
  // grace window (network-flicker-safe).
  const refreshCols = db.pragma('table_info(refresh_tokens)') as { name: string }[];
  if (refreshCols.length > 0 && !refreshCols.some((c) => c.name === 'superseded_at')) {
    db.exec('ALTER TABLE refresh_tokens ADD COLUMN superseded_at DATETIME DEFAULT NULL');
  }

  // Migration: turn refresh_tokens into the session store. Each surviving
  // refresh_token row IS a session; new columns describe the device that
  // owns it and let users see/manage their logged-in devices. Idempotent
  // — only adds missing columns.
  const refreshCols2 = db.pragma('table_info(refresh_tokens)') as { name: string }[];
  if (refreshCols2.length > 0 && !refreshCols2.some((c) => c.name === 'session_id')) {
    db.exec("ALTER TABLE refresh_tokens ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
  }
  if (refreshCols2.length > 0 && !refreshCols2.some((c) => c.name === 'device_name')) {
    db.exec('ALTER TABLE refresh_tokens ADD COLUMN device_name TEXT');
  }
  if (refreshCols2.length > 0 && !refreshCols2.some((c) => c.name === 'device_model')) {
    db.exec('ALTER TABLE refresh_tokens ADD COLUMN device_model TEXT');
  }
  if (refreshCols2.length > 0 && !refreshCols2.some((c) => c.name === 'device_os')) {
    db.exec('ALTER TABLE refresh_tokens ADD COLUMN device_os TEXT');
  }
  if (refreshCols2.length > 0 && !refreshCols2.some((c) => c.name === 'app_version')) {
    db.exec('ALTER TABLE refresh_tokens ADD COLUMN app_version TEXT');
  }
  if (refreshCols2.length > 0 && !refreshCols2.some((c) => c.name === 'last_active')) {
    db.exec('ALTER TABLE refresh_tokens ADD COLUMN last_active DATETIME');
  }
  if (refreshCols2.length > 0 && !refreshCols2.some((c) => c.name === 'is_primary')) {
    db.exec('ALTER TABLE refresh_tokens ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0');
  }
  if (refreshCols2.length > 0 && !refreshCols2.some((c) => c.name === 'revoked')) {
    db.exec('ALTER TABLE refresh_tokens ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0');
  }

  // Backfill: any pre-Step3 row has session_id = ''. Give it a fresh UUID
  // so it's identifiable. Each row becomes its own session — including
  // grace-window-superseded rows, but those will prune themselves after
  // 10s and don't surface in any list.
  const sidlessRows = db.prepare(
    "SELECT id FROM refresh_tokens WHERE session_id = ''"
  ).all() as { id: number }[];
  if (sidlessRows.length > 0) {
    const setSid = db.prepare('UPDATE refresh_tokens SET session_id = ? WHERE id = ?');
    db.transaction(() => {
      for (const r of sidlessRows) {
        setSid.run(crypto.randomUUID(), r.id);
      }
    })();
  }

  // Backfill: per user, the most-recently-issued non-superseded, non-
  // revoked row becomes the primary device. Idempotent (won't override an
  // existing primary). Window function requires SQLite ≥ 3.25 — better-
  // sqlite3 ships well past that.
  db.exec(`
    UPDATE refresh_tokens SET is_primary = 1
    WHERE id IN (
      SELECT id FROM (
        SELECT id, user_id,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn
        FROM refresh_tokens
        WHERE superseded_at IS NULL AND revoked = 0
      ) WHERE rn = 1
    )
    AND user_id NOT IN (
      SELECT user_id FROM refresh_tokens WHERE is_primary = 1
    )
  `);

  // Backfill: link existing device_tokens rows to their user's primary
  // session. The chronology between APNs token registration and refresh
  // token issuance is hard to reconstruct retroactively, so all of a
  // user's existing device tokens snap to one session — the primary —
  // which is also the one most likely to be live.
  db.exec(`
    UPDATE device_tokens SET session_id = (
      SELECT session_id FROM refresh_tokens
      WHERE user_id = device_tokens.user_id
        AND is_primary = 1 AND superseded_at IS NULL AND revoked = 0
      LIMIT 1
    )
    WHERE session_id IS NULL
  `);

  // Migration: backfill device_tokens from the legacy users.device_token
  // single-valued column. INSERT OR IGNORE so re-runs are no-ops. Once
  // every user with a token has a corresponding device_tokens row, the
  // legacy column is no longer read or written by app code (it stays in
  // schema for now to avoid an SQLite table-rebuild — drop in a later
  // commit after a full deployment cycle).
  const deviceTokenTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='device_tokens'"
  ).get() as { name: string } | undefined;
  if (deviceTokenTable) {
    db.exec(`
      INSERT OR IGNORE INTO device_tokens (apns_token, user_id, updated_at)
      SELECT device_token, id, CURRENT_TIMESTAMP
      FROM users
      WHERE device_token IS NOT NULL AND device_token != ''
    `);
  }

  // Migration: drop UNIQUE(user_id, week_key) on mailbox so the user can
  // ship multiple 次日达 within the same session (the original "one letter
  // per session" cap surfaced as "本场的信已封存，不能再修改"). The reveal
  // cadence still groups by session_key — every letter written in the
  // current session opens at the next session boundary on the recipient
  // side. SQLite can't drop a UNIQUE constraint in place; rebuild the
  // table.
  const mailboxTableDef = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='mailbox'"
  ).get() as { sql: string } | undefined;
  if (mailboxTableDef?.sql.includes('UNIQUE(user_id, week_key)') ||
      mailboxTableDef?.sql.includes('UNIQUE (user_id, week_key)')) {
    db.exec(`
      CREATE TABLE mailbox_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        week_key TEXT NOT NULL,
        content TEXT NOT NULL,
        locked INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT INTO mailbox_new (id, user_id, week_key, content, locked, created_at, updated_at)
        SELECT id, user_id, week_key, content, locked, created_at, updated_at FROM mailbox;
      DROP TABLE mailbox;
      ALTER TABLE mailbox_new RENAME TO mailbox;
      CREATE INDEX IF NOT EXISTS idx_mailbox_user_week ON mailbox(user_id, week_key);
      CREATE INDEX IF NOT EXISTS idx_mailbox_week_created ON mailbox(week_key, created_at);
    `);
    console.log('[Migration] Dropped UNIQUE(user_id, week_key) on mailbox — multi-letter sends per session are now allowed');
  }

  // Migration: add visibility column to time_capsules. Pre-existing capsules
  // default to 'partner' (the original product behavior was both-can-see).
  const capsuleCols = db.pragma('table_info(time_capsules)') as { name: string }[];
  if (capsuleCols.length > 0 && !capsuleCols.some((c) => c.name === 'visibility')) {
    db.exec("ALTER TABLE time_capsules ADD COLUMN visibility TEXT NOT NULL DEFAULT 'partner'");
  }

  // Migration: add unlock_at column for minute-precision capsule unlocks.
  // Pre-existing rows had only unlock_date (YYYY-MM-DD); backfill those to
  // midnight UTC of the date so existing capsules unlock at the same instant
  // they always have. New rows fill unlock_at directly from the client's
  // tz-aware picker (full ISO timestamp).
  if (capsuleCols.length > 0 && !capsuleCols.some((c) => c.name === 'unlock_at')) {
    db.exec("ALTER TABLE time_capsules ADD COLUMN unlock_at TEXT NOT NULL DEFAULT ''");
    // Backfill: empty unlock_at gets unlock_date + 'T00:00:00.000Z'.
    db.exec("UPDATE time_capsules SET unlock_at = unlock_date || 'T00:00:00.000Z' WHERE unlock_at = ''");
  }

  // Migration: add notified_at to dedupe capsule_unlock pushes across
  // server restarts. The previous in-memory `lastTriggered` Map cleared on
  // every restart, so a pm2 restart mid 5-min window would re-push the same
  // capsule. Backfill any already-due capsule as "already notified" — those
  // recipients have presumably seen their notification by now (or it never
  // came through because of the original bug; either way we don't want to
  // re-spam them on next deploy).
  if (capsuleCols.length > 0 && !capsuleCols.some((c) => c.name === 'notified_at')) {
    db.exec('ALTER TABLE time_capsules ADD COLUMN notified_at TEXT DEFAULT NULL');
    const nowIso = new Date().toISOString();
    db.prepare(
      'UPDATE time_capsules SET notified_at = unlock_at WHERE unlock_at <= ? AND notified_at IS NULL'
    ).run(nowIso);
  }

  // Migration: add layout_rotation column to sticky_blocks. Each committed
  // block now renders as its own paper with an independent tilt; this column
  // stores that tilt so both clients see the same arrangement. Pre-existing
  // committed blocks default to 0 and will be repaired by the relayout pass
  // below.
  const stickyBlocksTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sticky_blocks'"
  ).get();
  if (stickyBlocksTableExists) {
    const stickyBlockCols = db.pragma('table_info(sticky_blocks)') as { name: string }[];
    if (!stickyBlockCols.some((c) => c.name === 'layout_rotation')) {
      db.exec('ALTER TABLE sticky_blocks ADD COLUMN layout_rotation REAL NOT NULL DEFAULT 0');
    }
  }

  // Migration: relayout existing sticky_notes to the current standard
  // (creator-side left half [0.05..0.45] + tilt magnitude [1°..5°]). Old
  // rows posted under earlier rules — wider x range or taller tilts — would
  // otherwise sit on the wall mismatched against new posts. Idempotent: any
  // row already inside the standard is left alone, and re-randomization
  // only fires if at least one row falls outside.
  const stickyTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sticky_notes'"
  ).get();
  if (stickyTableExists) {
    const violator = db.prepare(`
      SELECT 1 FROM sticky_notes
      WHERE status = 'posted'
        AND (layout_x < 0.05 OR layout_x > 0.45
          OR ABS(layout_rotation) < 1 OR ABS(layout_rotation) > 5)
      LIMIT 1
    `).get();
    if (violator) {
      const ids = db.prepare(
        "SELECT id FROM sticky_notes WHERE status = 'posted'"
      ).all() as { id: number }[];
      const updateLayout = db.prepare(
        "UPDATE sticky_notes SET layout_x = ?, layout_rotation = ? WHERE id = ?"
      );
      const relayout = db.transaction((rows: { id: number }[]) => {
        for (const r of rows) {
          const x = 0.05 + Math.random() * 0.4;
          const sign = Math.random() > 0.5 ? 1 : -1;
          const rot = sign * (1 + Math.random() * 4);
          updateLayout.run(x, rot, r.id);
        }
      });
      relayout(ids);
      console.log(`[Migration] Relayout ${ids.length} sticky notes to current standard`);
    }
  }

  // Migration: same idempotent re-randomization for sticky_blocks tilts.
  // Catches pre-column rows (rotation=0) and anything outside [1°,5°].
  if (stickyBlocksTableExists) {
    const violatorBlock = db.prepare(`
      SELECT 1 FROM sticky_blocks
      WHERE status = 'committed'
        AND (ABS(layout_rotation) < 1 OR ABS(layout_rotation) > 5)
      LIMIT 1
    `).get();
    if (violatorBlock) {
      const ids = db.prepare(
        "SELECT id FROM sticky_blocks WHERE status = 'committed'"
      ).all() as { id: number }[];
      const updateBlockRot = db.prepare(
        "UPDATE sticky_blocks SET layout_rotation = ? WHERE id = ?"
      );
      const relayout = db.transaction((rows: { id: number }[]) => {
        for (const r of rows) {
          const sign = Math.random() > 0.5 ? 1 : -1;
          const rot = sign * (1 + Math.random() * 4);
          updateBlockRot.run(rot, r.id);
        }
      });
      relayout(ids);
      console.log(`[Migration] Relayout ${ids.length} sticky blocks to per-block tilt`);
    }
  }

  // ─── Phase B migrations: pair_id columns ─────────────────────────────────
  // Add pair_id TEXT to every couple-scoped table. Idempotent — only runs
  // when the column doesn't yet exist. Backfill happens in a separate pass
  // below, gated on the couples table being empty (= first deploy of the
  // pair_id model).
  const ensurePairIdCol = (table: string) => {
    const cols = db.pragma(`table_info(${table})`) as { name: string }[];
    if (!cols.some(c => c.name === 'pair_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN pair_id TEXT`);
    }
  };
  for (const t of ['actions', 'mailbox', 'time_capsules', 'bucket_items',
                   'sticky_notes', 'daily_answers', 'daily_reactions',
                   'important_dates', 'inbox_actions']) {
    ensurePairIdCol(t);
  }

  // pair_id-keyed indexes. Run AFTER the ALTER TABLE migrations above so
  // legacy databases (where pair_id was just added) have the column to
  // index. Fresh DBs already have the column from CREATE TABLE; the IF
  // NOT EXISTS guard makes both paths idempotent.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_couples_active ON couples(user_a_id, user_b_id) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_couples_ttl ON couples(ended_at) WHERE ended_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_actions_pair ON actions(pair_id);
    CREATE INDEX IF NOT EXISTS idx_mailbox_pair ON mailbox(pair_id);
    CREATE INDEX IF NOT EXISTS idx_capsules_pair ON time_capsules(pair_id);
    CREATE INDEX IF NOT EXISTS idx_bucket_pair ON bucket_items(pair_id);
    CREATE INDEX IF NOT EXISTS idx_dates_pair ON important_dates(pair_id);
    CREATE INDEX IF NOT EXISTS idx_answers_pair ON daily_answers(pair_id);
    CREATE INDEX IF NOT EXISTS idx_reactions_pair ON daily_reactions(pair_id);
    CREATE INDEX IF NOT EXISTS idx_sticky_pair ON sticky_notes(pair_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_actions_pair ON inbox_actions(pair_id);
  `);

  // Migration: rebuild daily_question_assignments with new PK
  // (pair_id, question_date). The old global PK question_date can't be
  // ALTERed in place. Drop + recreate; the data backfill below seeds
  // today's per-couple assignment from the old global one so users who
  // already answered today's question don't see a mismatched question
  // string (one-shot UX hack on migration day).
  const dqaCols = db.pragma('table_info(daily_question_assignments)') as { name: string }[];
  const dqaHasPairId = dqaCols.some(c => c.name === 'pair_id');
  if (dqaCols.length > 0 && !dqaHasPairId) {
    // Snapshot today's old global assignment so we can re-seed per couple.
    const todaySnapshotRow = db.prepare(
      "SELECT question_date, question_index FROM daily_question_assignments WHERE question_date = (SELECT MAX(question_date) FROM daily_question_assignments)"
    ).get() as { question_date: string; question_index: number } | undefined;

    db.exec(`
      CREATE TABLE daily_question_assignments_new (
        pair_id TEXT NOT NULL,
        question_date TEXT NOT NULL,
        question_index INTEGER NOT NULL,
        PRIMARY KEY (pair_id, question_date)
      );
      DROP TABLE daily_question_assignments;
      ALTER TABLE daily_question_assignments_new RENAME TO daily_question_assignments;
    `);
    if (todaySnapshotRow) {
      // Stash for later use during backfill (we need couple_id which
      // doesn't exist yet at this point).
      (db as any).__migrationDqaSnapshot = todaySnapshotRow;
    }
    console.log('[Migration] Rebuilt daily_question_assignments with (pair_id, question_date) PK');
  }

  // ─── D+ backfill: tag every couple-scoped legacy row with a pair_id ─────
  // Runs ONCE on the first deploy that adds the couples table (couples is
  // empty + at least one user has partner_id ≠ NULL). Subsequent boots
  // see a non-empty couples table and skip the entire pass.
  const couplesEmpty = (db.prepare('SELECT COUNT(*) AS n FROM couples').get() as { n: number }).n === 0;
  const anyPaired = (db.prepare('SELECT COUNT(*) AS n FROM users WHERE partner_id IS NOT NULL').get() as { n: number }).n > 0;
  if (couplesEmpty && anyPaired) {
    console.log('[Migration] First-deploy backfill of pair_id starting...');
    runPairIdBackfill(db);
    console.log('[Migration] First-deploy backfill of pair_id complete.');
  }

  const insertUser = db.prepare(
    'INSERT INTO users (id, name, password_hash, pair_code, timezone) VALUES (?, ?, ?, ?, ?)'
  );
  const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');
  const stmtGetUserByPairCode = db.prepare('SELECT * FROM users WHERE pair_code = ?');
  const updatePartner = db.prepare('UPDATE users SET partner_id = ? WHERE id = ?');
  const clearPartner = db.prepare('UPDATE users SET partner_id = NULL WHERE id = ?');
  const stmtUpdatePairCode = db.prepare('UPDATE users SET pair_code = ? WHERE id = ?');
  const stmtUpdateProfile = db.prepare('UPDATE users SET name = ?, timezone = ?, partner_timezone = ?, partner_remark = ? WHERE id = ?');
  // Stored in SQLite-default datetime format so lex comparison against
  // `created_at` (also stored in that format) works without any conversion.
  const stmtSetOutboxSeen = db.prepare('UPDATE users SET outbox_last_seen = ? WHERE id = ?');

  // ─── couples ops ─────────────────────────────────────────────────────────
  const stmtGetCoupleByUsers = db.prepare(
    'SELECT * FROM couples WHERE user_a_id = ? AND user_b_id = ?'
  );
  const stmtGetActivePairId = db.prepare(
    'SELECT pair_id FROM couples WHERE user_a_id = ? AND user_b_id = ? AND ended_at IS NULL'
  );
  const stmtInsertCouple = db.prepare(
    'INSERT INTO couples (pair_id, user_a_id, user_b_id) VALUES (?, ?, ?)'
  );
  const stmtClearCoupleEnded = db.prepare(
    'UPDATE couples SET ended_at = NULL WHERE pair_id = ?'
  );
  const stmtSetCoupleEnded = db.prepare(
    'UPDATE couples SET ended_at = CURRENT_TIMESTAMP WHERE pair_id = ? AND ended_at IS NULL'
  );
  const stmtDeleteCouple = db.prepare(
    'DELETE FROM couples WHERE pair_id = ?'
  );
  // 90-day TTL: couples whose ended_at is more than 90 days ago. datetime()
  // normalizes both formats so the comparison is well-defined regardless of
  // whether ended_at was written via CURRENT_TIMESTAMP (SQLite default
  // 'YYYY-MM-DD HH:MM:SS') or a manually-set ISO string.
  const stmtExpiredCouples = db.prepare(
    "SELECT pair_id, user_a_id, user_b_id, ended_at FROM couples WHERE ended_at IS NOT NULL AND datetime(ended_at, '+90 days') < datetime('now')"
  );
  // Hard-cleanup: every couple-scoped row that carries this pair_id is
  // deleted, then the couples row itself. inbox_actions is wiped first
  // because its ref_ids point into mailbox / time_capsules. sticky_blocks
  // are walked via their parent sticky_notes' pair_id.
  const stmtDelInboxActionsByPair = db.prepare('DELETE FROM inbox_actions WHERE pair_id = ?');
  const stmtDelStickyBlocksByPair = db.prepare(
    'DELETE FROM sticky_blocks WHERE sticky_id IN (SELECT id FROM sticky_notes WHERE pair_id = ?)'
  );
  const stmtDelStickySeenByPair = db.prepare(
    'DELETE FROM sticky_seen WHERE sticky_id IN (SELECT id FROM sticky_notes WHERE pair_id = ?)'
  );
  const stmtDelStickyNotesByPair = db.prepare('DELETE FROM sticky_notes WHERE pair_id = ?');
  const stmtDelMailboxByPair = db.prepare('DELETE FROM mailbox WHERE pair_id = ?');
  const stmtDelCapsulesByPair = db.prepare('DELETE FROM time_capsules WHERE pair_id = ?');
  const stmtDelBucketByPair = db.prepare('DELETE FROM bucket_items WHERE pair_id = ?');
  const stmtDelDatesByPair = db.prepare('DELETE FROM important_dates WHERE pair_id = ?');
  const stmtDelDailyAnswersByPair = db.prepare('DELETE FROM daily_answers WHERE pair_id = ?');
  const stmtDelDailyReactionsByPair = db.prepare('DELETE FROM daily_reactions WHERE pair_id = ?');
  const stmtDelDailyAssignByPair = db.prepare('DELETE FROM daily_question_assignments WHERE pair_id = ?');
  const stmtDelActionsByPair = db.prepare('DELETE FROM actions WHERE pair_id = ?');
  function deleteCoupleData(pairId: string): void {
    stmtDelInboxActionsByPair.run(pairId);
    stmtDelStickyBlocksByPair.run(pairId);
    stmtDelStickySeenByPair.run(pairId);
    stmtDelStickyNotesByPair.run(pairId);
    stmtDelMailboxByPair.run(pairId);
    stmtDelCapsulesByPair.run(pairId);
    stmtDelBucketByPair.run(pairId);
    stmtDelDatesByPair.run(pairId);
    stmtDelDailyAnswersByPair.run(pairId);
    stmtDelDailyReactionsByPair.run(pairId);
    stmtDelDailyAssignByPair.run(pairId);
    stmtDelActionsByPair.run(pairId);
  }
  // device_tokens: the canonical store post-migration. Multiple rows per
  // user → multi-device push. Same APNs token can only belong to one user
  // (an APNs token uniquely identifies a physical device — last account
  // to register on the device "wins").
  const stmtUpsertDeviceToken = db.prepare(`
    INSERT INTO device_tokens (apns_token, user_id, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(apns_token) DO UPDATE SET
      user_id = excluded.user_id,
      updated_at = CURRENT_TIMESTAMP
  `);
  const stmtDeleteDeviceTokensForUser = db.prepare(
    'DELETE FROM device_tokens WHERE user_id = ?'
  );
  const stmtDeleteDeviceTokenByValue = db.prepare(
    'DELETE FROM device_tokens WHERE apns_token = ?'
  );
  const stmtGetDeviceTokensForUser = db.prepare(
    'SELECT apns_token FROM device_tokens WHERE user_id = ?'
  );
  const stmtAttachDeviceTokenToSession = db.prepare(
    'UPDATE device_tokens SET session_id = ? WHERE apns_token = ?'
  );

  // Step 4 — synced "seen" markers + letter draft.
  const stmtGetDailySeen = db.prepare(
    'SELECT daily_seen_date AS date, daily_seen_pa AS pa, daily_seen_ps AS ps FROM users WHERE id = ?'
  );
  const stmtSetDailySeen = db.prepare(
    'UPDATE users SET daily_seen_date = ?, daily_seen_pa = ?, daily_seen_ps = ? WHERE id = ?'
  );
  const stmtGetInboxLastSeen = db.prepare(
    'SELECT inbox_last_seen FROM users WHERE id = ?'
  );
  // Only-advance: an out-of-order client write (e.g. older device coming
  // back online) must not roll the marker backwards and resurface
  // already-read letters as unread.
  const stmtSetInboxLastSeen = db.prepare(
    'UPDATE users SET inbox_last_seen = ? WHERE id = ? AND (inbox_last_seen IS NULL OR inbox_last_seen < ?)'
  );
  const stmtGetLetterDraft = db.prepare(
    'SELECT write_letter_draft FROM users WHERE id = ?'
  );
  const stmtSetLetterDraft = db.prepare(
    'UPDATE users SET write_letter_draft = ? WHERE id = ?'
  );
  // Only advance last_read_action_id forward — never let a client roll it back
  // (e.g. an out-of-order request) and accidentally re-mark old messages unread.
  const stmtSetLastReadActionId = db.prepare(
    'UPDATE users SET last_read_action_id = ? WHERE id = ? AND last_read_action_id < ?'
  );
  // Badge / unread tracking only counts top-level actions (reply_to IS NULL).
  // History feeds also filter reply_to IS NULL — so a reaction whose id sits
  // above the latest top-level would otherwise sit "unread" forever, since
  // the client's mark-read passes the latest *visible* id (top-level only).
  // Reactions render inline beneath their parent bubble; the parent's read
  // state covers them.
  const stmtCountUnreadActions = db.prepare(
    'SELECT COUNT(*) AS n FROM actions WHERE user_id = ? AND reply_to IS NULL AND id > ?'
  );
  const stmtLatestPartnerActionId = db.prepare(
    'SELECT IFNULL(MAX(id), 0) AS id FROM actions WHERE user_id = ? AND reply_to IS NULL'
  );
  const insertAction = db.prepare(
    'INSERT INTO actions (user_id, pair_id, action_type, sender_timezone, sender_name) VALUES (?, ?, ?, ?, ?)'
  );
  // pair_id-scoped history: returns ONLY actions tied to the current
  // relationship (re-pair scenarios don't leak earlier-pair actions).
  const getHistoryStmt = db.prepare(`
    SELECT a.id, a.user_id, a.action_type, a.sender_timezone, a.reply_to, a.created_at,
           CASE WHEN a.sender_name != '' THEN a.sender_name ELSE u.name END AS user_name
    FROM actions a
    JOIN users u ON a.user_id = u.id
    WHERE a.pair_id = ?
      AND a.reply_to IS NULL
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ?
  `);
  const stmtGetAction = db.prepare(`
    SELECT a.id, a.user_id, a.action_type, a.sender_timezone, a.reply_to, a.created_at,
           CASE WHEN a.sender_name != '' THEN a.sender_name ELSE u.name END AS user_name
    FROM actions a JOIN users u ON a.user_id = u.id WHERE a.id = ?
  `);
  const insertReaction = db.prepare(
    'INSERT INTO actions (user_id, pair_id, action_type, sender_timezone, sender_name, reply_to) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const stmtGetReaction = db.prepare(`
    SELECT a.id, a.user_id, a.action_type, a.sender_timezone, a.reply_to, a.created_at,
           CASE WHEN a.sender_name != '' THEN a.sender_name ELSE u.name END AS user_name
    FROM actions a JOIN users u ON a.user_id = u.id
    WHERE a.reply_to = ? AND a.user_id = ?
  `);
  const stmtUpdateReaction = db.prepare('UPDATE actions SET action_type = ? WHERE id = ?');
  // Reactions for the current page of /api/history actions. Built per
  // call because the IN(...) placeholder count varies with the page
  // size. Old version capped at LIMIT 500 across the entire pair —
  // long-term couples could lose reactions for older messages once the
  // 500-most-recent cutoff overflowed past the visible range.
  const buildReactionsForActionsStmt = (n: number) => db.prepare(`
    SELECT a.id, a.user_id, a.action_type, a.sender_timezone, a.reply_to, a.created_at,
           CASE WHEN a.sender_name != '' THEN a.sender_name ELSE u.name END AS user_name
    FROM actions a
    JOIN users u ON a.user_id = u.id
    WHERE a.reply_to IN (${Array.from({ length: n }, () => '?').join(',')})
      AND a.pair_id = ?
    ORDER BY a.created_at DESC
  `);
  const stmtInsertRefreshToken = db.prepare(`
    INSERT INTO refresh_tokens (
      user_id, token_hash, expires_at,
      session_id, device_name, device_model, device_os, app_version,
      last_active, is_primary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
  `);
  const stmtGetRefreshToken = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?');
  const stmtDeleteRefreshToken = db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?');
  const stmtDeleteAllRefreshTokens = db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?');
  // Bug-2 fix: rotate supersedes ALL still-active rows of the same session
  // before inserting the new one. Without this, a 10s-grace retry leaves
  // both the original new row and the retry's new row active under the
  // same session_id — /sessions would show duplicates.
  const stmtMarkSessionSuperseded = db.prepare(
    'UPDATE refresh_tokens SET superseded_at = CURRENT_TIMESTAMP WHERE session_id = ? AND superseded_at IS NULL'
  );
  // datetime() normalizes both formats so we can compare an ISO param
  // against the SQLite-default timestamp the column was written with.
  const stmtPruneRefreshTokens = db.prepare(
    "DELETE FROM refresh_tokens WHERE datetime(expires_at) < datetime('now') OR (superseded_at IS NOT NULL AND datetime(superseded_at, '+10 seconds') < datetime('now'))"
  );
  const stmtIncrementTokenVersion = db.prepare(
    'UPDATE users SET token_version = token_version + 1 WHERE id = ?'
  );

  // Session management statements.
  const stmtCheckSessionActive = db.prepare(`
    SELECT 1 FROM refresh_tokens
    WHERE session_id = ? AND user_id = ?
      AND superseded_at IS NULL
      AND revoked = 0
      AND datetime(expires_at) >= datetime('now')
    LIMIT 1
  `);
  const stmtListSessions = db.prepare(`
    SELECT session_id, device_name, device_model, device_os, app_version,
           last_active, created_at, is_primary
    FROM refresh_tokens
    WHERE user_id = ?
      AND superseded_at IS NULL
      AND revoked = 0
      AND datetime(expires_at) >= datetime('now')
    ORDER BY is_primary DESC, COALESCE(last_active, created_at) DESC
  `);
  const stmtClearAllPrimary = db.prepare(
    'UPDATE refresh_tokens SET is_primary = 0 WHERE user_id = ?'
  );
  const stmtSetPrimary = db.prepare(`
    UPDATE refresh_tokens SET is_primary = 1
    WHERE session_id = ? AND user_id = ?
      AND superseded_at IS NULL AND revoked = 0
  `);
  const stmtRevokeSession = db.prepare(`
    UPDATE refresh_tokens SET revoked = 1
    WHERE session_id = ? AND revoked = 0
  `);
  const stmtDeleteDeviceTokensBySession = db.prepare(
    'DELETE FROM device_tokens WHERE session_id = ?'
  );
  const stmtSessionHasPrimary = db.prepare(`
    SELECT 1 FROM refresh_tokens
    WHERE user_id = ? AND is_primary = 1
      AND superseded_at IS NULL AND revoked = 0
    LIMIT 1
  `);
  const stmtPickFallbackPrimary = db.prepare(`
    SELECT session_id FROM refresh_tokens
    WHERE user_id = ?
      AND superseded_at IS NULL AND revoked = 0
      AND datetime(expires_at) >= datetime('now')
    ORDER BY COALESCE(last_active, created_at) DESC
    LIMIT 1
  `);
  const stmtTouchSession = db.prepare(`
    UPDATE refresh_tokens SET last_active = CURRENT_TIMESTAMP
    WHERE session_id = ? AND superseded_at IS NULL AND revoked = 0
  `);
  const stmtGetSession = db.prepare(`
    SELECT * FROM refresh_tokens
    WHERE session_id = ? AND superseded_at IS NULL AND revoked = 0
    LIMIT 1
  `);
  // Rename every still-active session whose (device_name, device_os)
  // matches the target's. The device list in the app dedups rows by
  // that same key, so this keeps the visible row & every session it
  // represents in lockstep — tap-to-rename feels like renaming "this
  // device", not "this row in particular". `IS` is used for null-aware
  // equality so an old row that has NULL device_name still groups.
  const stmtRenameSessionGroup = db.prepare(`
    UPDATE refresh_tokens SET device_name = ?
    WHERE user_id = ?
      AND device_name IS ?
      AND device_os IS ?
      AND superseded_at IS NULL
      AND revoked = 0
  `);
  // Same fingerprint-based group select / revoke pair used by the
  // group-revoke endpoint. Doing it server-side in one transaction is
  // load-bearing: the client used to fan out parallel DELETEs, but as
  // soon as our own row went revoked=1 the auth middleware on the
  // sibling DELETEs returned 401, leaving the rest of the group active
  // and reappearing in the device list after re-login.
  const stmtSelectGroupSessionIds = db.prepare(`
    SELECT session_id FROM refresh_tokens
    WHERE user_id = ?
      AND device_name IS ?
      AND device_os IS ?
      AND superseded_at IS NULL
      AND revoked = 0
  `);
  const stmtRevokeGroupSessions = db.prepare(`
    UPDATE refresh_tokens SET revoked = 1
    WHERE user_id = ?
      AND device_name IS ?
      AND device_os IS ?
      AND superseded_at IS NULL
      AND revoked = 0
  `);
  // For login-time name inheritance: if the user has no still-active
  // session matching the incoming device_os (i.e. they just logged out
  // & are coming back), pick the most-recent prior name for that OS so
  // a re-login keeps the rename instead of resetting to "iPhone". Only
  // counts active rows here so a multi-device scenario with a sibling
  // still online doesn't accidentally rename the new session after the
  // sibling.
  const stmtCountActiveSessionsByOs = db.prepare(`
    SELECT COUNT(*) AS n FROM refresh_tokens
    WHERE user_id = ?
      AND device_os IS ?
      AND superseded_at IS NULL
      AND revoked = 0
      AND datetime(expires_at) >= datetime('now')
  `);
  const stmtMostRecentDeviceNameByOs = db.prepare(`
    SELECT device_name FROM refresh_tokens
    WHERE user_id = ?
      AND device_os IS ?
      AND device_name IS NOT NULL
    ORDER BY COALESCE(last_active, created_at) DESC
    LIMIT 1
  `);

  // Streak day boundary aligns with the BJT 7am session boundary used by
  // daily-question / daily-snap (UTC 23h = BJT 7am). Without the +1h shift,
  // a NY user's 9pm action lands on UTC's "next day" while their partner's
  // BJT 8am same-calendar-day action lands on the prior UTC day — so the
  // pair never shares a streak day across timezones. The +1h shift gives
  // both sides a stable shared anchor.
  const stmtGetStreak = db.prepare(`
    WITH daily_activity AS (
      SELECT DATE(created_at, '+1 hour') AS day, user_id
      FROM actions
      WHERE user_id IN (?, ?) AND reply_to IS NULL
      GROUP BY DATE(created_at, '+1 hour'), user_id
    ),
    both_active AS (
      SELECT day FROM daily_activity
      GROUP BY day HAVING COUNT(DISTINCT user_id) = 2
    ),
    numbered AS (
      SELECT day,
        JULIANDAY(day) - ROW_NUMBER() OVER (ORDER BY day) AS grp
      FROM both_active
    ),
    streaks AS (
      SELECT grp, MAX(day) AS end_day, COUNT(*) AS length
      FROM numbered GROUP BY grp
    )
    SELECT length FROM streaks
    WHERE end_day >= DATE('now', '+1 hour', '-1 day')
    ORDER BY end_day DESC LIMIT 1
  `);

  const stmtInsertDate = db.prepare(
    'INSERT INTO important_dates (user_id, partner_id, pair_id, title, date, recurring) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const stmtGetDateById = db.prepare('SELECT * FROM important_dates WHERE id = ?');
  const stmtGetDates = db.prepare(
    'SELECT * FROM important_dates WHERE pair_id = ? ORDER BY date ASC'
  );
  const stmtUpdateDate = db.prepare(
    'UPDATE important_dates SET title = ?, date = ?, recurring = ? WHERE id = ? AND pair_id = ?'
  );
  const stmtDeleteDate = db.prepare(
    'DELETE FROM important_dates WHERE id = ? AND pair_id = ?'
  );
  const stmtUnpinAll = db.prepare(
    'UPDATE important_dates SET pinned = 0 WHERE pair_id = ?'
  );
  const stmtPinDate = db.prepare(
    'UPDATE important_dates SET pinned = 1 WHERE id = ? AND pair_id = ?'
  );

  const stmtSubmitAnswer = db.prepare(
    'INSERT OR REPLACE INTO daily_answers (user_id, pair_id, question_date, question_index, answer) VALUES (?, ?, ?, ?, ?)'
  );
  const stmtGetDailyAnswers = db.prepare(
    'SELECT * FROM daily_answers WHERE question_date = ? AND pair_id = ?'
  );
  const stmtGetAssignment = db.prepare(
    'SELECT question_index FROM daily_question_assignments WHERE pair_id = ? AND question_date = ?'
  );
  const stmtSetAssignment = db.prepare(
    'INSERT OR IGNORE INTO daily_question_assignments (pair_id, question_date, question_index) VALUES (?, ?, ?)'
  );
  const stmtCompletedIndexes = db.prepare(`
    SELECT DISTINCT question_index FROM daily_answers WHERE pair_id = ?
  `);

  // Stats: pair_id-scoped so re-pair scenarios don't dilute the current
  // relationship's numbers with leftover counts from a past pairing.
  const stmtStatsTotalByUser = db.prepare(
    'SELECT user_id, COUNT(*) as count FROM actions WHERE pair_id = ? AND reply_to IS NULL GROUP BY user_id'
  );
  const stmtStatsTopActions = db.prepare(
    'SELECT action_type, COUNT(*) as count FROM actions WHERE pair_id = ? AND reply_to IS NULL GROUP BY action_type ORDER BY count DESC LIMIT 10'
  );
  const stmtStatsHourly = db.prepare(
    "SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count FROM actions WHERE pair_id = ? AND reply_to IS NULL GROUP BY hour ORDER BY hour"
  );
  const stmtStatsMonthly = db.prepare(
    "SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count FROM actions WHERE pair_id = ? AND reply_to IS NULL GROUP BY month ORDER BY month DESC LIMIT 12"
  );
  const stmtStatsFirstDate = db.prepare(
    'SELECT MIN(created_at) as first_date FROM actions WHERE pair_id = ? AND reply_to IS NULL'
  );

  // Ritual statements
  const stmtSubmitRitual = db.prepare(
    'INSERT OR IGNORE INTO rituals (user_id, ritual_type, ritual_date) VALUES (?, ?, ?)'
  );
  const stmtGetRituals = db.prepare(
    'SELECT * FROM rituals WHERE ritual_date = ? AND user_id IN (?, ?)'
  );
  const stmtGetRitualsMultiDate = db.prepare(
    'SELECT * FROM rituals WHERE ((ritual_date = ? AND user_id = ?) OR (ritual_date = ? AND user_id = ?))'
  );
  // Daily recap counts interactions in a user-tz local-day window. The
  // window is passed as a UTC ISO range (start inclusive, end exclusive)
  // computed by the route layer — `created_at` is stored in UTC and
  // compared lexicographically as ISO strings here, which matches
  // chronological order for the same SQLite default timestamp format.
  const stmtDailyRecapCount = db.prepare(
    "SELECT COUNT(*) as total FROM actions WHERE user_id IN (?, ?) AND reply_to IS NULL AND created_at >= ? AND created_at < ?"
  );
  const stmtDailyRecapTop = db.prepare(
    "SELECT action_type, COUNT(*) as cnt FROM actions WHERE user_id IN (?, ?) AND reply_to IS NULL AND created_at >= ? AND created_at < ? GROUP BY action_type ORDER BY cnt DESC LIMIT 1"
  );

  // Mailbox statements
  // Multiple letters per (user, session) are allowed — the UNIQUE
  // constraint that used to enforce "one letter per session" was dropped.
  // Each row is sealed at insert (locked=1) and never updated.
  const stmtSubmitMailbox = db.prepare(
    'INSERT INTO mailbox (user_id, pair_id, week_key, content, locked) VALUES (?, ?, ?, ?, 1)'
  );
  // Returns all rows in a session that belong to this couple (filtered by
  // pair_id, not user_id IN tuple). Caller picks mine/partner via user_id.
  const stmtGetMailboxMessages = db.prepare(
    'SELECT * FROM mailbox WHERE week_key = ? AND pair_id = ? ORDER BY id ASC'
  );
  // Per-letter archive: pair_id-scoped, partner-authored, soft-delete
  // filtered. Re-pair safety: a re-pair revives this couple's pair_id so
  // their full archive resurfaces; a different intermediate pair has its
  // own pair_id and stays hidden.
  const stmtGetMailboxArchive = db.prepare(`
    SELECT m.id as partner_message_id,
      m.week_key,
      m.content as partner_content,
      m.created_at as partner_created_at
    FROM mailbox m
    LEFT JOIN inbox_actions ia
      ON ia.user_id = ? AND ia.kind = 'mailbox' AND ia.ref_id = m.id
        AND ia.status IN ('trashed', 'purged')
    WHERE m.pair_id = ? AND m.user_id = ? AND ia.id IS NULL
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `);
  // Outbox: my own mailbox letters in a single session, scoped to the
  // current pair_id (re-pair scenarios don't leak earlier-pair queued
  // letters that happen to share the session_key).
  const stmtGetMyMailboxInSession = db.prepare(`
    SELECT id, week_key, content, created_at
    FROM mailbox
    WHERE user_id = ? AND pair_id = ? AND week_key = ?
    ORDER BY created_at ASC, id ASC
  `);
  // Scheduler broadcast — every APNs token belonging to a paired user.
  // Joining device_tokens against users so unpaired accounts (waiting on
  // partner) don't get scheduler-driven notifications like weekly_report
  // or mailbox_open that have nothing meaningful to show them.
  const stmtGetAllPairedTokens = db.prepare(`
    SELECT dt.apns_token AS device_token
    FROM device_tokens dt
    JOIN users u ON u.id = dt.user_id
    WHERE u.partner_id IS NOT NULL
  `);
  // Distinct paired user ids — driver for scheduler broadcasts that need
  // per-user push (so badge can be computed per recipient).
  const stmtGetAllPairedUserIds = db.prepare(`
    SELECT DISTINCT u.id
    FROM device_tokens dt
    JOIN users u ON u.id = dt.user_id
    WHERE u.partner_id IS NOT NULL
  `);

  // ─── Total-unread-badge composition ──────────────────────────────────────
  // Each statement is scoped to a (recipient, partner, pair) tuple so a
  // re-pair scenario doesn't leak prior-pair counts into the badge.
  // Mailbox: partner-authored letters in the active pair, not soft-deleted
  // by this user, with created_at past their inbox-last-seen marker.
  // datetime() normalizes both sides — `m.created_at` is SQLite default
  // ('YYYY-MM-DD HH:MM:SS') while `inbox_last_seen` is ISO with the 'T'
  // separator and trailing 'Z'; lex-comparing them directly is wrong
  // because ' ' (0x20) < 'T' (0x54) so the marker would always look later.
  const stmtCountUnreadInboxMailbox = db.prepare(`
    SELECT COUNT(*) AS n FROM mailbox m
    LEFT JOIN inbox_actions ia
      ON ia.user_id = ? AND ia.kind = 'mailbox' AND ia.ref_id = m.id
        AND ia.status IN ('trashed', 'purged')
    WHERE m.user_id = ? AND m.pair_id = ?
      AND datetime(m.created_at) > datetime(IFNULL(?, '1970-01-01'))
      AND ia.id IS NULL
  `);
  // Capsule: partner-bound capsules whose unlock_at has elapsed and the
  // recipient hasn't opened yet. Self-vis capsules are excluded (those
  // belong to the author's own future-self letterbox, not the partner's).
  const stmtCountUnreadInboxCapsules = db.prepare(`
    SELECT COUNT(*) AS n FROM time_capsules c
    LEFT JOIN inbox_actions ia
      ON ia.user_id = ? AND ia.kind = 'capsule' AND ia.ref_id = c.id
        AND ia.status IN ('trashed', 'purged')
    WHERE c.partner_id = ? AND c.pair_id = ?
      AND c.visibility = 'partner'
      AND c.unlock_at <= ?
      AND c.opened_at IS NULL
      AND ia.id IS NULL
  `);
  // Sticky: partner-authored committed blocks newer than this user's
  // per-sticky last_seen cursor. Stickies without a sticky_seen row use
  // last_seen_block_id = 0 (every partner block counts).
  const stmtCountUnreadStickyBlocks = db.prepare(`
    SELECT COUNT(*) AS n FROM sticky_blocks b
    JOIN sticky_notes s ON s.id = b.sticky_id
    LEFT JOIN sticky_seen ss ON ss.user_id = ? AND ss.sticky_id = b.sticky_id
    WHERE s.pair_id = ?
      AND b.author_id = ?
      AND b.status = 'committed'
      AND b.id > IFNULL(ss.last_seen_block_id, 0)
  `);

  // Weekly report statements
  const stmtWeekActions = db.prepare(
    'SELECT user_id, COUNT(*) as count FROM actions WHERE user_id IN (?, ?) AND reply_to IS NULL AND created_at >= ? AND created_at < ? GROUP BY user_id'
  );
  const stmtWeekTopActions = db.prepare(
    'SELECT action_type, COUNT(*) as count FROM actions WHERE user_id IN (?, ?) AND reply_to IS NULL AND created_at >= ? AND created_at < ? GROUP BY action_type ORDER BY count DESC LIMIT 5'
  );
  const stmtWeekQuestionDays = db.prepare(`
    SELECT COUNT(DISTINCT a1.question_date) as days FROM daily_answers a1
    JOIN daily_answers a2 ON a1.question_date = a2.question_date AND a1.user_id != a2.user_id
    WHERE a1.user_id = ? AND a2.user_id = ? AND a1.question_date >= ? AND a1.question_date < ?
  `);
  const stmtWeekRitualDays = db.prepare(`
    SELECT r1.ritual_type as ritual_type, COUNT(DISTINCT r1.ritual_date) as days FROM rituals r1
    JOIN rituals r2 ON r1.ritual_date = r2.ritual_date AND r1.ritual_type = r2.ritual_type AND r1.user_id != r2.user_id
    WHERE r1.user_id IN (?, ?) AND r2.user_id IN (?, ?) AND r1.ritual_date >= ? AND r1.ritual_date < ?
    GROUP BY r1.ritual_type
  `);

  // Time capsule statements
  const stmtInsertCapsule = db.prepare(
    'INSERT INTO time_capsules (user_id, partner_id, pair_id, content, unlock_date, unlock_at, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const stmtGetCapsuleById = db.prepare('SELECT * FROM time_capsules WHERE id = ?');
  const stmtGetCapsules = db.prepare(
    'SELECT * FROM time_capsules WHERE pair_id = ? ORDER BY unlock_date ASC'
  );
  const stmtOpenCapsule = db.prepare(
    'UPDATE time_capsules SET opened_at = CURRENT_TIMESTAMP WHERE id = ? AND opened_at IS NULL'
  );
  const stmtUnlockableCapsules = db.prepare(
    'SELECT * FROM time_capsules WHERE unlock_at <= ? AND opened_at IS NULL AND notified_at IS NULL'
  );
  const stmtMarkCapsuleNotified = db.prepare(
    'UPDATE time_capsules SET notified_at = ? WHERE id = ?'
  );

  // Bucket list statements
  const stmtInsertBucket = db.prepare(
    'INSERT INTO bucket_items (user_id, partner_id, pair_id, title, category) VALUES (?, ?, ?, ?, ?)'
  );
  const stmtGetBucketById = db.prepare('SELECT * FROM bucket_items WHERE id = ?');
  const stmtGetBucketItems = db.prepare(
    'SELECT * FROM bucket_items WHERE pair_id = ? ORDER BY completed ASC, created_at DESC'
  );
  const stmtCompleteBucket = db.prepare(
    'UPDATE bucket_items SET completed = 1, completed_by = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?'
  );
  const stmtUncompleteBucket = db.prepare(
    'UPDATE bucket_items SET completed = 0, completed_by = NULL, completed_at = NULL WHERE id = ?'
  );
  const stmtDeleteBucket = db.prepare(
    'DELETE FROM bucket_items WHERE id = ? AND (user_id = ? OR partner_id = ?)'
  );

  // Daily reaction statements (👍/👎 on partner's daily content)
  // DO NOTHING so a concurrent second insert can't bypass the route-level
  // "one-shot" check (which currently runs same-tick under better-sqlite3
  // sync API; this is defense in depth for any future multi-instance setup).
  const stmtSetDailyReaction = db.prepare(`
    INSERT INTO daily_reactions (reactor_id, target_user_id, pair_id, target_date, target_type, reaction)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(reactor_id, target_user_id, target_date, target_type)
    DO NOTHING
  `);
  const stmtGetDailyReaction = db.prepare(
    'SELECT reaction FROM daily_reactions WHERE reactor_id = ? AND target_user_id = ? AND target_date = ? AND target_type = ?'
  );

  const stmtGetMailboxMessageById = db.prepare('SELECT * FROM mailbox WHERE id = ?');

  // Inbox action statements (soft delete / restore / purge per recipient)
  const stmtSetInboxAction = db.prepare(`
    INSERT INTO inbox_actions (user_id, pair_id, kind, ref_id, status, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, kind, ref_id)
    DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP
  `);
  const stmtClearInboxAction = db.prepare(
    'DELETE FROM inbox_actions WHERE user_id = ? AND kind = ? AND ref_id = ?'
  );
  const stmtGetInboxActionStatus = db.prepare(
    'SELECT status FROM inbox_actions WHERE user_id = ? AND kind = ? AND ref_id = ?'
  );
  // Trashed mailbox messages: only partner-authored ones (the recipient's
  // inbox) joined with the author's name from users table.
  const stmtGetTrashedMailbox = db.prepare(`
    SELECT m.id as ref_id, m.week_key as date, m.content, ia.updated_at as trashed_at
    FROM inbox_actions ia
    JOIN mailbox m ON m.id = ia.ref_id
    WHERE ia.user_id = ? AND ia.kind = 'mailbox' AND ia.status = 'trashed'
      AND m.user_id = ?
    ORDER BY ia.updated_at DESC
  `);
  const stmtGetTrashedCapsules = db.prepare(`
    SELECT c.id as ref_id, c.unlock_date as date, c.content, c.user_id, c.visibility,
           ia.updated_at as trashed_at
    FROM inbox_actions ia
    JOIN time_capsules c ON c.id = ia.ref_id
    WHERE ia.user_id = ? AND ia.kind = 'capsule' AND ia.status = 'trashed'
      AND c.opened_at IS NOT NULL
    ORDER BY ia.updated_at DESC
  `);

  // Daily snap statements
  const stmtInsertSnap = db.prepare(
    'INSERT OR IGNORE INTO daily_snaps (user_id, snap_date, photo_path) VALUES (?, ?, ?)'
  );
  const stmtGetSnap = db.prepare(
    'SELECT * FROM daily_snaps WHERE user_id = ? AND snap_date = ?'
  );
  const stmtDeleteSnap = db.prepare(
    'DELETE FROM daily_snaps WHERE user_id = ? AND snap_date = ?'
  );
  const stmtGetSnapsMonth = db.prepare(`
    SELECT s.snap_date,
      MAX(CASE WHEN s.user_id = ? THEN s.photo_path END) as user_photo,
      MAX(CASE WHEN s.user_id = ? THEN s.photo_path END) as partner_photo
    FROM daily_snaps s
    WHERE s.user_id IN (?, ?) AND s.snap_date >= ? AND s.snap_date < ?
    GROUP BY s.snap_date ORDER BY s.snap_date DESC
  `);

  // Sticky note (每日一帖) statements
  const stmtGetTempSticky = db.prepare(
    "SELECT * FROM sticky_notes WHERE user_id = ? AND status = 'temp' LIMIT 1"
  );
  const stmtInsertTempSticky = db.prepare(
    "INSERT INTO sticky_notes (user_id, partner_id, pair_id, status) VALUES (?, ?, ?, 'temp')"
  );
  const stmtGetStickyById = db.prepare('SELECT * FROM sticky_notes WHERE id = ?');
  const stmtUpdateTempStickyContent = db.prepare(`
    UPDATE sticky_blocks SET content = ?
    WHERE sticky_id = (SELECT id FROM sticky_notes WHERE user_id = ? AND status = 'temp' LIMIT 1)
      AND author_id = ? AND status = 'temp'
  `);
  // Postable iff a temp sticky exists for this user AND its initial temp block
  // exists. The transaction wrapper in postSticky() does the row-level work;
  // these statements are the building blocks.
  const stmtPostStickyHeader = db.prepare(`
    UPDATE sticky_notes
    SET status = 'posted', posted_at = CURRENT_TIMESTAMP, layout_x = ?, layout_rotation = ?
    WHERE id = ? AND status = 'temp'
  `);
  const stmtCommitStickyInitialBlock = db.prepare(`
    UPDATE sticky_blocks
    SET status = 'committed', committed_at = CURRENT_TIMESTAMP,
        content = ?, layout_rotation = ?
    WHERE sticky_id = ? AND author_id = ? AND status = 'temp'
  `);
  const stmtDeleteTempStickyBlocks = db.prepare(
    "DELETE FROM sticky_blocks WHERE sticky_id = ? AND status = 'temp'"
  );
  const stmtDeleteTempStickyHeader = db.prepare(
    "DELETE FROM sticky_notes WHERE user_id = ? AND status = 'temp'"
  );

  // Wall query: posted stickies between this couple, newest first. partner_id
  // is matched to the snapshot stored on each row, so stickies from a previous
  // pairing don't leak into the current couple's wall after re-pairing.
  const stmtListWallStickies = db.prepare(`
    SELECT * FROM sticky_notes
    WHERE status = 'posted' AND pair_id = ?
    ORDER BY posted_at DESC, id DESC
    LIMIT ?
  `);
  const stmtGetStickyForCouple = db.prepare(`
    SELECT * FROM sticky_notes
    WHERE id = ? AND pair_id = ?
    LIMIT 1
  `);
  const stmtMaxCommittedBlockIdOnSticky = db.prepare(`
    SELECT IFNULL(MAX(id), 0) AS m FROM sticky_blocks
    WHERE sticky_id = ? AND status = 'committed'
  `);

  // Block lifecycle for "再写点" / "先写这么多".
  const stmtGetTempBlock = db.prepare(
    "SELECT * FROM sticky_blocks WHERE sticky_id = ? AND author_id = ? AND status = 'temp' LIMIT 1"
  );
  const stmtInsertTempBlock = db.prepare(
    "INSERT INTO sticky_blocks (sticky_id, author_id, content, status) VALUES (?, ?, '', 'temp')"
  );
  const stmtGetBlockById = db.prepare('SELECT * FROM sticky_blocks WHERE id = ?');
  const stmtUpdateTempBlockContent = db.prepare(
    "UPDATE sticky_blocks SET content = ? WHERE sticky_id = ? AND author_id = ? AND status = 'temp'"
  );
  const stmtDeleteTempBlock = db.prepare(
    "DELETE FROM sticky_blocks WHERE sticky_id = ? AND author_id = ? AND status = 'temp'"
  );
  const stmtCommitBlock = db.prepare(`
    UPDATE sticky_blocks
    SET status = 'committed', committed_at = CURRENT_TIMESTAMP,
        content = ?, layout_rotation = ?
    WHERE sticky_id = ? AND author_id = ? AND status = 'temp'
  `);

  // Pick a random tilt for a freshly-committed block, in the same magnitude
  // range as posts ([1°, 5°]). Independent per block so a thread of stapled
  // papers reads as visually scattered, not perfectly aligned.
  function pickBlockRotation(): number {
    const sign = Math.random() > 0.5 ? 1 : -1;
    return sign * (1 + Math.random() * 4);
  }

  // Per-recipient seen cursor.
  const stmtUpsertStickySeen = db.prepare(`
    INSERT INTO sticky_seen (user_id, sticky_id, last_seen_block_id)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, sticky_id)
    DO UPDATE SET last_seen_block_id = MAX(sticky_seen.last_seen_block_id, excluded.last_seen_block_id)
  `);

  // Tear-off: remove a sticky and everything that hangs off it. SQLite isn't
  // configured with foreign_keys=ON, so we cascade in JS inside one tx.
  const stmtDeleteStickyBlocks = db.prepare('DELETE FROM sticky_blocks WHERE sticky_id = ?');
  const stmtDeleteStickySeenRows = db.prepare('DELETE FROM sticky_seen WHERE sticky_id = ?');
  const stmtDeleteStickyNote = db.prepare('DELETE FROM sticky_notes WHERE id = ?');

  // Per-block delete: oldest committed block on a sticky is the "原帖" and
  // can't go via this path (deleteCommittedBlock returns first_block).
  const stmtFirstCommittedBlockId = db.prepare(
    "SELECT id FROM sticky_blocks WHERE sticky_id = ? AND status = 'committed' ORDER BY committed_at ASC, id ASC LIMIT 1"
  );
  const stmtDeleteCommittedBlockById = db.prepare(
    "DELETE FROM sticky_blocks WHERE id = ? AND sticky_id = ? AND author_id = ? AND status = 'committed'"
  );

  const dbOps: DbOps = {
    createUser(id: string, name: string, passwordHash: string, pairCode: string, timezone: string): void {
      insertUser.run(id, name, passwordHash, pairCode, timezone);
    },

    getUser(id: string): User | undefined {
      return getUserById.get(id) as User | undefined;
    },

    getUserByPairCode(pairCode: string): User | undefined {
      return stmtGetUserByPairCode.get(pairCode) as User | undefined;
    },

    pairUsers(userId: string, partnerId: string): void {
      db.transaction(() => {
        updatePartner.run(partnerId, userId);
        updatePartner.run(userId, partnerId);
      })();
    },

    unpairUsers(userId: string, partnerId: string): void {
      db.transaction(() => {
        clearPartner.run(userId);
        clearPartner.run(partnerId);
      })();
    },

    couplesGetActivePairId(userIdA: string, userIdB: string): string | null {
      const [a, b] = sortedPair(userIdA, userIdB);
      const row = stmtGetActivePairId.get(a, b) as { pair_id: string } | undefined;
      return row?.pair_id ?? null;
    },

    couplesGetOrCreatePair(userIdA: string, userIdB: string): { pair_id: string; revived: boolean } {
      const [a, b] = sortedPair(userIdA, userIdB);
      return db.transaction(() => {
        const existing = stmtGetCoupleByUsers.get(a, b) as Couple | undefined;
        if (existing) {
          if (existing.ended_at === null) {
            // Already active — caller logic shouldn't reach here; pair
            // route's "already paired" check upstream catches it. Returns
            // existing pair_id as a no-op for safety.
            return { pair_id: existing.pair_id, revived: false };
          }
          // Past TTL safety net: if cron didn't get to it yet, hard-clean
          // here so the new pair starts fresh. Compare datetime() to
          // normalize SQLite + ISO formats consistently.
          const expiredCheck = db.prepare(
            "SELECT 1 AS expired FROM couples WHERE pair_id = ? AND datetime(ended_at, '+90 days') < datetime('now')"
          ).get(existing.pair_id) as { expired: number } | undefined;
          if (expiredCheck?.expired) {
            deleteCoupleData(existing.pair_id);
            stmtDeleteCouple.run(existing.pair_id);
            // fall through to fresh-create
          } else {
            // Within grace window — revive: clear ended_at, all data
            // tagged with this pair_id resurfaces.
            stmtClearCoupleEnded.run(existing.pair_id);
            return { pair_id: existing.pair_id, revived: true };
          }
        }
        // Brand new (or post-TTL fresh start). Generate pair_id with
        // retry on the (extremely rare) collision.
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidate = generatePairId();
          try {
            stmtInsertCouple.run(candidate, a, b);
            return { pair_id: candidate, revived: false };
          } catch (e: any) {
            if (e?.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && e?.code !== 'SQLITE_CONSTRAINT_UNIQUE') {
              throw e;
            }
            // collision — try again
          }
        }
        throw new Error('Failed to generate unique pair_id after 8 attempts');
      })();
    },

    couplesEndPair(userIdA: string, userIdB: string): void {
      const [a, b] = sortedPair(userIdA, userIdB);
      const row = stmtGetActivePairId.get(a, b) as { pair_id: string } | undefined;
      if (row) stmtSetCoupleEnded.run(row.pair_id);
    },

    pairCouple(userIdA: string, userIdB: string): { pair_id: string; revived: boolean } {
      // Single outer transaction so a kill-9 between the two ops can't
      // leave the DB in "couples row active but users.partner_id null"
      // state. better-sqlite3 nests via SAVEPOINT — the inner
      // `couplesGetOrCreatePair` transaction joins this one cleanly.
      return db.transaction(() => {
        const r = this.couplesGetOrCreatePair(userIdA, userIdB);
        updatePartner.run(userIdB, userIdA);
        updatePartner.run(userIdA, userIdB);
        return r;
      })();
    },

    unpairCouple(userIdA: string, userIdB: string): void {
      db.transaction(() => {
        this.couplesEndPair(userIdA, userIdB);
        clearPartner.run(userIdA);
        clearPartner.run(userIdB);
      })();
    },

    couplesCleanupExpired(): string[] {
      const expired = stmtExpiredCouples.all() as { pair_id: string; user_a_id: string; user_b_id: string; ended_at: string }[];
      const deleted: string[] = [];
      for (const c of expired) {
        // Per-couple try/catch so one bad row (FK weirdness, deadlock
        // simulation, etc.) doesn't block the rest of the batch from
        // being cleaned this run. Logged for observability; a stuck
        // couple will be retried on tomorrow's cron tick.
        try {
          db.transaction(() => {
            deleteCoupleData(c.pair_id);
            stmtDeleteCouple.run(c.pair_id);
          })();
          deleted.push(c.pair_id);
        } catch (err) {
          console.error(`[TTL] Failed to clean up couple ${c.pair_id}:`, err);
        }
      }
      return deleted;
    },

    updatePairCode(userId: string, pairCode: string): void {
      stmtUpdatePairCode.run(pairCode, userId);
    },

    updateProfile(userId: string, name: string, timezone: string, partnerTimezone: string, partnerRemark: string): void {
      stmtUpdateProfile.run(name, timezone, partnerTimezone, partnerRemark, userId);
    },

    setDeviceToken(userId: string, token: string): void {
      if (!token) return;
      // ON CONFLICT clause re-points an existing apns_token row to the new
      // user_id atomically — same physical device handed over to a
      // different account stops pushing to the previous owner.
      stmtUpsertDeviceToken.run(token, userId);
    },

    clearDeviceToken(userId: string): void {
      // Logout: drop every device this user had registered. Matches the
      // legacy single-token semantics (logout cleared the one slot) but
      // now covers all devices.
      stmtDeleteDeviceTokensForUser.run(userId);
    },

    clearDeviceTokenByValue(token: string): void {
      // Called by the APNs error handler on Unregistered/BadDeviceToken —
      // drop just that one row, leave the user's other devices alone.
      if (!token) return;
      stmtDeleteDeviceTokenByValue.run(token);
    },

    getDeviceTokensForUser(userId: string): string[] {
      const rows = stmtGetDeviceTokensForUser.all(userId) as { apns_token: string }[];
      return rows.map((r) => r.apns_token);
    },

    attachDeviceTokenToSession(apnsToken, sessionId): void {
      stmtAttachDeviceTokenToSession.run(sessionId, apnsToken);
    },

    getDailySeen(userId): { date: string | null; pa: boolean; ps: boolean } {
      const row = stmtGetDailySeen.get(userId) as
        | { date: string | null; pa: number; ps: number }
        | undefined;
      if (!row) return { date: null, pa: false, ps: false };
      return { date: row.date, pa: row.pa === 1, ps: row.ps === 1 };
    },

    setDailySeen(userId, date, pa, ps): void {
      stmtSetDailySeen.run(date, pa ? 1 : 0, ps ? 1 : 0, userId);
    },

    getInboxLastSeen(userId): string | null {
      const row = stmtGetInboxLastSeen.get(userId) as { inbox_last_seen: string | null } | undefined;
      return row?.inbox_last_seen ?? null;
    },

    setInboxLastSeen(userId, iso): void {
      stmtSetInboxLastSeen.run(iso, userId, iso);
    },

    getLetterDraft(userId): string {
      const row = stmtGetLetterDraft.get(userId) as { write_letter_draft: string } | undefined;
      return row?.write_letter_draft ?? '';
    },

    setLetterDraft(userId, draft): void {
      stmtSetLetterDraft.run(draft, userId);
    },

    setLastReadActionId(userId: string, actionId: number): void {
      stmtSetLastReadActionId.run(actionId, userId, actionId);
    },

    getUnreadActionCount(userId: string, partnerId: string): number {
      const user = getUserById.get(userId) as User | undefined;
      if (!user) return 0;
      const row = stmtCountUnreadActions.get(partnerId, user.last_read_action_id) as { n: number };
      return row?.n ?? 0;
    },

    getLatestPartnerActionId(_userId: string, partnerId: string): number {
      const row = stmtLatestPartnerActionId.get(partnerId) as { id: number };
      return row?.id ?? 0;
    },

    addAction(userId: string, pairId: string, actionType: string, senderTimezone: string, senderName: string): void {
      insertAction.run(userId, pairId, actionType, senderTimezone, senderName);
    },

    getAction(actionId: number): Action | undefined {
      return stmtGetAction.get(actionId) as Action | undefined;
    },

    addReaction(userId: string, pairId: string, actionType: string, senderTimezone: string, senderName: string, replyTo: number): number {
      const existing = stmtGetReaction.get(replyTo, userId) as Action | undefined;
      if (existing) {
        stmtUpdateReaction.run(actionType, existing.id);
        return existing.id;
      }
      const result = insertReaction.run(userId, pairId, actionType, senderTimezone, senderName, replyTo);
      return Number(result.lastInsertRowid);
    },

    getReaction(actionId: number, userId: string): Action | undefined {
      return stmtGetReaction.get(actionId, userId) as Action | undefined;
    },

    updateReaction(reactionId: number, actionType: string): void {
      stmtUpdateReaction.run(actionType, reactionId);
    },

    getHistory(pairId: string, limit: number): Action[] {
      return getHistoryStmt.all(pairId, limit) as Action[];
    },

    getHistoryReactions(pairId: string, parentActionIds: number[]): Action[] {
      if (parentActionIds.length === 0) return [];
      // SQLite's compiled-statement parameter limit is 999 by default;
      // /api/history caps `limit` at 200, so we never get close. Still,
      // be explicit so a future caller can't blow up the engine.
      const ids = parentActionIds.slice(0, 999);
      const stmt = buildReactionsForActionsStmt(ids.length);
      return stmt.all(...ids, pairId) as Action[];
    },

    insertRefreshToken(userId, tokenHash, expiresAt, sessionId, deviceInfo, isPrimary): void {
      // First device for the user always gets primary if caller didn't
      // specify; subsequent devices default to non-primary unless caller
      // explicitly promotes (e.g. login on a brand-new phone could be
      // either, today we leave it to the user to promote manually).
      const flag = isPrimary ? 1 : 0;
      stmtInsertRefreshToken.run(
        userId,
        tokenHash,
        expiresAt,
        sessionId,
        deviceInfo?.name ?? null,
        deviceInfo?.model ?? null,
        deviceInfo?.os ?? null,
        deviceInfo?.app_version ?? null,
        flag,
      );
    },

    getRefreshToken(tokenHash: string): RefreshToken | undefined {
      return stmtGetRefreshToken.get(tokenHash) as RefreshToken | undefined;
    },

    deleteRefreshToken(tokenHash: string): void {
      stmtDeleteRefreshToken.run(tokenHash);
    },

    rotateRefreshToken(oldHash, userId, newHash, expiresAt, sessionId): void {
      // Bug-1 + Bug-2 fix: supersede ALL still-active rows for this
      // session (covers old hash + any orphan from a previous mid-rotate
      // retry) before inserting the new row. The new row inherits the
      // session's metadata (device info + primary flag) by reading the
      // most-recent row for the same session in a single transaction.
      db.transaction(() => {
        const prior = db.prepare(`
          SELECT device_name, device_model, device_os, app_version, is_primary
          FROM refresh_tokens
          WHERE session_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `).get(sessionId) as {
          device_name: string | null;
          device_model: string | null;
          device_os: string | null;
          app_version: string | null;
          is_primary: number;
        } | undefined;

        stmtMarkSessionSuperseded.run(sessionId);
        stmtInsertRefreshToken.run(
          userId,
          newHash,
          expiresAt,
          sessionId,
          prior?.device_name ?? null,
          prior?.device_model ?? null,
          prior?.device_os ?? null,
          prior?.app_version ?? null,
          prior?.is_primary ?? 0,
        );
      })();
    },

    pruneRefreshTokens(): void {
      stmtPruneRefreshTokens.run();
    },

    deleteAllRefreshTokens(userId: string): void {
      stmtDeleteAllRefreshTokens.run(userId);
    },

    incrementTokenVersion(userId: string): void {
      stmtIncrementTokenVersion.run(userId);
    },

    isSessionActive(sessionId, userId): boolean {
      return stmtCheckSessionActive.get(sessionId, userId) !== undefined;
    },

    listSessionsForUser(userId, currentSessionId): SessionView[] {
      const rows = stmtListSessions.all(userId) as Array<{
        session_id: string;
        device_name: string | null;
        device_model: string | null;
        device_os: string | null;
        app_version: string | null;
        last_active: string | null;
        created_at: string;
        is_primary: number;
      }>;
      return rows.map((r) => ({
        session_id: r.session_id,
        device_name: r.device_name,
        device_model: r.device_model,
        device_os: r.device_os,
        app_version: r.app_version,
        last_active: r.last_active,
        created_at: r.created_at,
        is_primary: r.is_primary === 1,
        is_current: r.session_id === currentSessionId,
      }));
    },

    setPrimarySession(userId, sessionId): void {
      // Two-step in one transaction. Without the transaction, a parallel
      // setPrimary on another session could land between the clear and
      // the set, leaving zero primaries.
      db.transaction(() => {
        stmtClearAllPrimary.run(userId);
        stmtSetPrimary.run(sessionId, userId);
      })();
    },

    revokeSession(sessionId): boolean {
      let changed = 0;
      db.transaction(() => {
        const result = stmtRevokeSession.run(sessionId);
        changed = result.changes;
        stmtDeleteDeviceTokensBySession.run(sessionId);
      })();
      return changed > 0;
    },

    inheritDeviceNameForOs(userId, deviceOs): string | null {
      if (!deviceOs) return null;
      const active = stmtCountActiveSessionsByOs.get(userId, deviceOs) as { n: number } | undefined;
      if ((active?.n ?? 0) > 0) return null;
      const row = stmtMostRecentDeviceNameByOs.get(userId, deviceOs) as { device_name: string | null } | undefined;
      const name = row?.device_name?.trim();
      return name || null;
    },

    revokeSessionGroup(userId, sessionId): string[] {
      const target = stmtGetSession.get(sessionId) as RefreshToken | undefined;
      if (!target || target.user_id !== userId) return [];
      let revokedSids: string[] = [];
      db.transaction(() => {
        const rows = stmtSelectGroupSessionIds.all(
          userId,
          target.device_name,
          target.device_os,
        ) as Array<{ session_id: string }>;
        revokedSids = rows.map((r) => r.session_id);
        stmtRevokeGroupSessions.run(userId, target.device_name, target.device_os);
        for (const sid of revokedSids) {
          stmtDeleteDeviceTokensBySession.run(sid);
        }
      })();
      return revokedSids;
    },

    renameSessionGroup(userId, sessionId, newName): boolean {
      const target = stmtGetSession.get(sessionId) as RefreshToken | undefined;
      if (!target || target.user_id !== userId) return false;
      const result = stmtRenameSessionGroup.run(
        newName,
        userId,
        target.device_name,
        target.device_os,
      );
      return result.changes > 0;
    },

    promoteFallbackPrimary(userId): void {
      const hasPrimary = stmtSessionHasPrimary.get(userId) !== undefined;
      if (hasPrimary) return;
      const fallback = stmtPickFallbackPrimary.get(userId) as { session_id: string } | undefined;
      if (!fallback) return;
      stmtSetPrimary.run(fallback.session_id, userId);
    },

    touchSessionLastActive(sessionId): void {
      stmtTouchSession.run(sessionId);
    },

    getSession(sessionId): RefreshToken | undefined {
      return stmtGetSession.get(sessionId) as RefreshToken | undefined;
    },

    getActiveSessionForUser(userId, sessionId): RefreshToken | undefined {
      const row = stmtGetSession.get(sessionId) as RefreshToken | undefined;
      if (!row || row.user_id !== userId) return undefined;
      return row;
    },

    getStreak(userId: string, partnerId: string): number {
      const row = stmtGetStreak.get(userId, partnerId) as { length: number } | undefined;
      return row?.length ?? 0;
    },

    createImportantDate(userId: string, partnerId: string, pairId: string, title: string, date: string, recurring: boolean): ImportantDate {
      const result = stmtInsertDate.run(userId, partnerId, pairId, title, date, recurring ? 1 : 0);
      return stmtGetDateById.get(result.lastInsertRowid) as ImportantDate;
    },

    getImportantDates(pairId: string): ImportantDate[] {
      return stmtGetDates.all(pairId) as ImportantDate[];
    },

    updateImportantDate(id: number, title: string, date: string, recurring: boolean, pairId: string): boolean {
      const result = stmtUpdateDate.run(title, date, recurring ? 1 : 0, id, pairId);
      return result.changes > 0;
    },

    deleteImportantDate(id: number, pairId: string): boolean {
      const result = stmtDeleteDate.run(id, pairId);
      return result.changes > 0;
    },

    pinImportantDate(id: number, pairId: string): void {
      db.transaction(() => {
        stmtUnpinAll.run(pairId);
        stmtPinDate.run(id, pairId);
      })();
    },

    submitDailyAnswer(userId: string, pairId: string, questionDate: string, questionIndex: number, answer: string): void {
      stmtSubmitAnswer.run(userId, pairId, questionDate, questionIndex, answer);
    },

    getDailyAnswers(questionDate: string, pairId: string, userId: string): { mine?: DailyAnswer; partner?: DailyAnswer } {
      const rows = stmtGetDailyAnswers.all(questionDate, pairId) as DailyAnswer[];
      let mine: DailyAnswer | undefined;
      let partner: DailyAnswer | undefined;
      for (const row of rows) {
        if (row.user_id === userId) mine = row;
        else partner = row;
      }
      return { mine, partner };
    },

    getQuestionAssignment(pairId: string, questionDate: string): number | null {
      const row = stmtGetAssignment.get(pairId, questionDate) as { question_index: number } | undefined;
      return row?.question_index ?? null;
    },

    setQuestionAssignment(pairId: string, questionDate: string, questionIndex: number): void {
      stmtSetAssignment.run(pairId, questionDate, questionIndex);
    },

    getCompletedQuestionIndexes(pairId: string): Set<number> {
      const rows = stmtCompletedIndexes.all(pairId) as { question_index: number }[];
      return new Set(rows.map(r => r.question_index));
    },

    getStats(pairId: string, userId: string): StatsData {
      const byUser = stmtStatsTotalByUser.all(pairId) as { user_id: string; count: number }[];
      let myActions = 0, partnerActions = 0;
      for (const row of byUser) {
        if (row.user_id === userId) myActions = row.count;
        else partnerActions = row.count;
      }
      const topActions = stmtStatsTopActions.all(pairId) as { action_type: string; count: number }[];
      const hourly = stmtStatsHourly.all(pairId) as { hour: number; count: number }[];
      const monthly = stmtStatsMonthly.all(pairId) as { month: string; count: number }[];
      const firstRow = stmtStatsFirstDate.get(pairId) as { first_date: string | null } | undefined;

      return {
        total_actions: myActions + partnerActions,
        my_actions: myActions,
        partner_actions: partnerActions,
        top_actions: topActions,
        hourly,
        monthly,
        first_action_date: firstRow?.first_date?.slice(0, 10) ?? null,
      };
    },

    // Rituals
    submitRitual(userId: string, ritualType: 'morning' | 'evening', ritualDate: string): boolean {
      const result = stmtSubmitRitual.run(userId, ritualType, ritualDate);
      return result.changes > 0;
    },

    getRituals(ritualDate: string, userId: string, partnerId: string): Ritual[] {
      return stmtGetRituals.all(ritualDate, userId, partnerId) as Ritual[];
    },

    getRitualsByDates(myDate: string, partnerDate: string, userId: string, partnerId: string): { myMorning: boolean; myEvening: boolean; partnerMorning: boolean; partnerEvening: boolean } {
      const rows = stmtGetRitualsMultiDate.all(myDate, userId, partnerDate, partnerId) as Ritual[];
      let myMorning = false, myEvening = false, partnerMorning = false, partnerEvening = false;
      for (const r of rows) {
        if (r.user_id === userId && r.ritual_type === 'morning') myMorning = true;
        if (r.user_id === userId && r.ritual_type === 'evening') myEvening = true;
        if (r.user_id === partnerId && r.ritual_type === 'morning') partnerMorning = true;
        if (r.user_id === partnerId && r.ritual_type === 'evening') partnerEvening = true;
      }
      return { myMorning, myEvening, partnerMorning, partnerEvening };
    },

    getDailyRecap(userId: string, partnerId: string, startUtcIso: string, endUtcIso: string): { total_interactions: number; top_action: string | null } {
      // Convert ISO ('YYYY-MM-DDTHH:mm:ss.sssZ') to SQLite-stored format
      // ('YYYY-MM-DD HH:MM:SS') so the lexicographic comparison against
      // `created_at` is well-defined (T vs space lexicography would
      // otherwise corrupt the range).
      const start = startUtcIso.slice(0, 19).replace('T', ' ');
      const end = endUtcIso.slice(0, 19).replace('T', ' ');
      const countRow = stmtDailyRecapCount.get(userId, partnerId, start, end) as { total: number };
      const topRow = stmtDailyRecapTop.get(userId, partnerId, start, end) as { action_type: string } | undefined;
      return { total_interactions: countRow.total, top_action: topRow?.action_type ?? null };
    },

    // Mailbox
    submitMailboxMessage(userId: string, pairId: string, weekKey: string, content: string): boolean {
      const result = stmtSubmitMailbox.run(userId, pairId, weekKey, content);
      return result.changes > 0;
    },

    getMailboxMessages(weekKey: string, pairId: string, userId: string): { mine?: MailboxMessage; partner?: MailboxMessage } {
      const rows = stmtGetMailboxMessages.all(weekKey, pairId) as MailboxMessage[];
      let mine: MailboxMessage | undefined;
      let partner: MailboxMessage | undefined;
      for (const row of rows) {
        if (row.user_id === userId) mine = row;
        else partner = row;
      }
      return { mine, partner };
    },

    getMailboxArchive(userId: string, pairId: string, partnerId: string, limit: number): { week_key: string; my_content: string | null; partner_content: string | null; partner_message_id: number | null; partner_created_at: string | null }[] {
      // One row per partner-authored letter in this pair, soft-delete
      // filtered. `my_content: null` keeps the response shape stable for
      // the inbox client.
      const rows = stmtGetMailboxArchive.all(
        userId,    // ia.user_id (viewer's trash state)
        pairId,    // m.pair_id  (only this couple's mail)
        partnerId, // m.user_id  (partner-authored only)
        limit
      ) as { week_key: string; partner_content: string; partner_message_id: number; partner_created_at: string }[];
      return rows.map(r => ({
        week_key: r.week_key,
        my_content: null,
        partner_content: r.partner_content,
        partner_message_id: r.partner_message_id,
        partner_created_at: r.partner_created_at,
      }));
    },

    getMyMailboxInSession(userId: string, pairId: string, weekKey: string): { id: number; week_key: string; content: string; created_at: string }[] {
      return stmtGetMyMailboxInSession.all(userId, pairId, weekKey) as any[];
    },

    markOutboxSeen(userId: string): void {
      // Match SQLite default `CURRENT_TIMESTAMP` format ('YYYY-MM-DD HH:MM:SS'
      // UTC, no T, no Z) so lex compare with `created_at` columns works.
      const nowSqlite = new Date().toISOString().slice(0, 19).replace('T', ' ');
      stmtSetOutboxSeen.run(nowSqlite, userId);
    },

    getAllPairedUserTokens(): { device_token: string }[] {
      return stmtGetAllPairedTokens.all() as { device_token: string }[];
    },

    getAllPairedUserIds(): string[] {
      return (stmtGetAllPairedUserIds.all() as { id: string }[]).map(r => r.id);
    },

    getTotalUnreadBadge(userId: string): number {
      const user = getUserById.get(userId) as User | undefined;
      if (!user || !user.partner_id) return 0;
      const partnerId = user.partner_id;

      // History — uses the existing prepared statement that already powers
      // the per-tab unread count; reusing keeps a single source of truth.
      const h = stmtCountUnreadActions.get(partnerId, user.last_read_action_id) as { n: number } | undefined;

      const [a, b] = sortedPair(userId, partnerId);
      const pairRow = stmtGetActivePairId.get(a, b) as { pair_id: string } | undefined;
      const pairId = pairRow?.pair_id;
      // No active pair (mid-unpair / never paired): only history can have
      // residual unread; everything else is pair-scoped, so return early.
      if (!pairId) return h?.n ?? 0;

      // inbox_last_seen lives on `users` but isn't on the User interface;
      // hit the row directly to avoid an extra round-trip helper.
      const inboxRow = stmtGetInboxLastSeen.get(userId) as { inbox_last_seen: string | null } | undefined;
      const inboxLastSeen = inboxRow?.inbox_last_seen ?? null;
      const nowIso = new Date().toISOString();

      const m = stmtCountUnreadInboxMailbox.get(userId, partnerId, pairId, inboxLastSeen) as { n: number } | undefined;
      const c = stmtCountUnreadInboxCapsules.get(userId, userId, pairId, nowIso) as { n: number } | undefined;
      const s = stmtCountUnreadStickyBlocks.get(userId, pairId, partnerId) as { n: number } | undefined;

      return (h?.n ?? 0) + (m?.n ?? 0) + (c?.n ?? 0) + (s?.n ?? 0);
    },

    // Weekly Report
    getWeeklyReportData(
      userId: string, partnerId: string,
      weekStart: string, weekEnd: string,
      actionsStart: string, actionsEnd: string,
    ) {
      const lastWeekStartDate = new Date(weekStart);
      lastWeekStartDate.setDate(lastWeekStartDate.getDate() - 7);
      const lastWeekStart = lastWeekStartDate.toISOString().slice(0, 10);

      // For the previous-week actions count, we need the equivalent UTC
      // bound for the prior Monday at local-midnight. Derive from the
      // current actionsStart by subtracting 7 days in ms — week boundaries
      // are stable across DST except for the spring-forward / fall-back
      // weekend, where this is at most ±1h off (acceptable for a weekly
      // total displayed for trend context).
      const lastActionsStart = new Date(new Date(actionsStart.replace(' ', 'T') + 'Z').getTime() - 7 * 24 * 3600 * 1000)
        .toISOString().slice(0, 19).replace('T', ' ');

      const byUser = stmtWeekActions.all(userId, partnerId, actionsStart, actionsEnd) as { user_id: string; count: number }[];
      let myCount = 0, partnerCount = 0;
      for (const r of byUser) {
        if (r.user_id === userId) myCount = r.count;
        else partnerCount = r.count;
      }

      const lastByUser = stmtWeekActions.all(userId, partnerId, lastActionsStart, actionsStart) as { user_id: string; count: number }[];
      let lastWeekTotal = 0;
      for (const r of lastByUser) lastWeekTotal += r.count;

      const topActions = stmtWeekTopActions.all(userId, partnerId, actionsStart, actionsEnd) as { action_type: string; count: number }[];

      // question_date / ritual_date are stored as YYYY-MM-DD in the
      // writer's local frame, so date-only weekStart/weekEnd are the
      // right comparison values here.
      const qRow = stmtWeekQuestionDays.get(userId, partnerId, weekStart, weekEnd) as { days: number };
      const dailyQuestionDays = qRow?.days ?? 0;

      const ritualRows = stmtWeekRitualDays.all(userId, partnerId, userId, partnerId, weekStart, weekEnd) as { ritual_type: string; days: number }[];
      let ritualMorningDays = 0, ritualEveningDays = 0;
      for (const r of ritualRows) {
        if (r.ritual_type === 'morning') ritualMorningDays = r.days;
        if (r.ritual_type === 'evening') ritualEveningDays = r.days;
      }

      // lastWeekStart kept for callers that want it.
      void lastWeekStart;

      return { total: myCount + partnerCount, lastWeekTotal, myCount, partnerCount, topActions, dailyQuestionDays, ritualMorningDays, ritualEveningDays };
    },

    // Time Capsules
    createCapsule(userId: string, partnerId: string, pairId: string, content: string, unlockDate: string, unlockAt: string, visibility: 'self' | 'partner'): TimeCapsule {
      const result = stmtInsertCapsule.run(userId, partnerId, pairId, content, unlockDate, unlockAt, visibility);
      return stmtGetCapsuleById.get(result.lastInsertRowid) as TimeCapsule;
    },

    getCapsules(pairId: string): TimeCapsule[] {
      return stmtGetCapsules.all(pairId) as TimeCapsule[];
    },

    openCapsule(id: number): boolean {
      const result = stmtOpenCapsule.run(id);
      return result.changes > 0;
    },

    getUnlockableCapsules(nowIso: string): TimeCapsule[] {
      return stmtUnlockableCapsules.all(nowIso) as TimeCapsule[];
    },

    markCapsulesNotified(capsuleIds: number[], nowIso: string): void {
      if (capsuleIds.length === 0) return;
      const tx = db.transaction((ids: number[]) => {
        for (const id of ids) stmtMarkCapsuleNotified.run(nowIso, id);
      });
      tx(capsuleIds);
    },

    // Bucket List
    createBucketItem(userId: string, partnerId: string, pairId: string, title: string, category: string | null): BucketItem {
      const result = stmtInsertBucket.run(userId, partnerId, pairId, title, category);
      return stmtGetBucketById.get(result.lastInsertRowid) as BucketItem;
    },

    getBucketItems(pairId: string): BucketItem[] {
      return stmtGetBucketItems.all(pairId) as BucketItem[];
    },

    completeBucketItem(id: number, userId: string): boolean {
      const result = stmtCompleteBucket.run(userId, id);
      return result.changes > 0;
    },

    uncompleteBucketItem(id: number): boolean {
      const result = stmtUncompleteBucket.run(id);
      return result.changes > 0;
    },

    deleteBucketItem(id: number, userId: string, partnerId: string): boolean {
      const result = stmtDeleteBucket.run(id, userId, partnerId);
      return result.changes > 0;
    },

    // Daily Snaps
    saveSnap(userId: string, snapDate: string, photoPath: string): boolean {
      const result = stmtInsertSnap.run(userId, snapDate, photoPath);
      return result.changes > 0;
    },

    saveSnapAtomic(userId, partnerId, snapDate, photoPath) {
      return db.transaction(() => {
        const result = stmtInsertSnap.run(userId, snapDate, photoPath);
        if (result.changes === 0) return { saved: false, bothSnapped: false };
        const partnerSnap = stmtGetSnap.get(partnerId, snapDate) as DailySnap | undefined;
        return { saved: true, bothSnapped: !!partnerSnap };
      })();
    },

    deleteSnap(userId: string, snapDate: string): void {
      stmtDeleteSnap.run(userId, snapDate);
    },

    getSnap(userId: string, snapDate: string): DailySnap | undefined {
      return stmtGetSnap.get(userId, snapDate) as DailySnap | undefined;
    },

    getSnaps(userId: string, partnerId: string, month: string): { snap_date: string; user_photo: string | null; partner_photo: string | null }[] {
      const [y, m] = month.split('-').map(Number);
      const startDate = `${month}-01`;
      const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      return stmtGetSnapsMonth.all(userId, partnerId, userId, partnerId, startDate, nextMonth) as any[];
    },

    setDailyReaction(reactorId, targetUserId, pairId, targetDate, targetType, reaction): void {
      stmtSetDailyReaction.run(reactorId, targetUserId, pairId, targetDate, targetType, reaction);
    },

    getDailyReaction(reactorId, targetUserId, targetDate, targetType): 'up' | 'down' | null {
      const row = stmtGetDailyReaction.get(reactorId, targetUserId, targetDate, targetType) as { reaction: 'up' | 'down' } | undefined;
      return row?.reaction ?? null;
    },

    setInboxAction(userId, pairId, kind, refId, status): void {
      stmtSetInboxAction.run(userId, pairId, kind, refId, status);
    },

    clearInboxAction(userId, kind, refId): void {
      stmtClearInboxAction.run(userId, kind, refId);
    },

    getInboxActionStatus(userId, kind, refId): 'trashed' | 'purged' | null {
      const row = stmtGetInboxActionStatus.get(userId, kind, refId) as { status: 'trashed' | 'purged' } | undefined;
      return row?.status ?? null;
    },

    getTrashedInboxItems(userId, partnerId): TrashedInboxItem[] {
      const mailboxRows = stmtGetTrashedMailbox.all(userId, partnerId) as {
        ref_id: number; date: string; content: string; trashed_at: string;
      }[];
      const capsuleRows = stmtGetTrashedCapsules.all(userId) as {
        ref_id: number; date: string; content: string; user_id: string;
        visibility: 'self' | 'partner'; trashed_at: string;
      }[];

      const out: TrashedInboxItem[] = [];
      for (const r of mailboxRows) {
        out.push({
          kind: 'mailbox',
          ref_id: r.ref_id,
          date: r.date,
          content: r.content,
          author: 'partner',
          visibility: 'partner',
          trashed_at: r.trashed_at,
        });
      }
      for (const r of capsuleRows) {
        out.push({
          kind: 'capsule',
          ref_id: r.ref_id,
          date: r.date,
          content: r.content,
          author: r.user_id === userId ? 'me' : 'partner',
          visibility: r.visibility,
          trashed_at: r.trashed_at,
        });
      }
      out.sort((a, b) => (a.trashed_at < b.trashed_at ? 1 : a.trashed_at > b.trashed_at ? -1 : 0));
      return out;
    },

    getMailboxMessageById(id): MailboxMessage | undefined {
      return stmtGetMailboxMessageById.get(id) as MailboxMessage | undefined;
    },

    getCapsuleById(id): TimeCapsule | undefined {
      return stmtGetCapsuleById.get(id) as TimeCapsule | undefined;
    },

    // -- Sticky notes (每日一帖) -------------------------------------------

    getTempSticky(userId): StickyNote | undefined {
      return stmtGetTempSticky.get(userId) as StickyNote | undefined;
    },

    createTempSticky(userId, partnerId, pairId): { sticky: StickyNote; block: StickyBlock } {
      // Atomic: a temp sticky always carries an initial empty temp block. The
      // route layer guarantees there's no existing temp first, so we don't
      // bother with INSERT OR IGNORE here.
      return db.transaction(() => {
        const result = stmtInsertTempSticky.run(userId, partnerId, pairId);
        const stickyId = Number(result.lastInsertRowid);
        const blockResult = stmtInsertTempBlock.run(stickyId, userId);
        const sticky = stmtGetStickyById.get(stickyId) as StickyNote;
        const block = stmtGetBlockById.get(Number(blockResult.lastInsertRowid)) as StickyBlock;
        return { sticky, block };
      })();
    },

    updateTempStickyContent(userId, content): boolean {
      const result = stmtUpdateTempStickyContent.run(content, userId, userId);
      return result.changes > 0;
    },

    deleteTempSticky(userId): boolean {
      // Cascade through the temp blocks first; SQLite has no ON DELETE
      // CASCADE without PRAGMA foreign_keys=ON which we don't enable here.
      return db.transaction(() => {
        const temp = stmtGetTempSticky.get(userId) as StickyNote | undefined;
        if (!temp) return false;
        stmtDeleteTempStickyBlocks.run(temp.id);
        const result = stmtDeleteTempStickyHeader.run(userId);
        return result.changes > 0;
      })();
    },

    postSticky(userId, content, layoutX, layoutRotation): { sticky: StickyNote; block: StickyBlock } | null {
      return db.transaction(() => {
        const temp = stmtGetTempSticky.get(userId) as StickyNote | undefined;
        if (!temp) return null;
        const headerResult = stmtPostStickyHeader.run(layoutX, layoutRotation, temp.id);
        if (headerResult.changes === 0) return null;
        // Each block carries its own random tilt independent of the sticky's
        // overall rotation — drives the multi-paper "stapled stack" look.
        const blockRotation = pickBlockRotation();
        const blockResult = stmtCommitStickyInitialBlock.run(content, blockRotation, temp.id, userId);
        if (blockResult.changes === 0) return null;
        const sticky = stmtGetStickyById.get(temp.id) as StickyNote;
        // After commit the original temp row is now 'committed' — fetch by
        // (sticky, author, committed) to get the canonical initial block.
        const block = db.prepare(
          "SELECT * FROM sticky_blocks WHERE sticky_id = ? AND author_id = ? AND status = 'committed' ORDER BY id ASC LIMIT 1"
        ).get(temp.id, userId) as StickyBlock;
        return { sticky, block };
      })();
    },

    getStickyForCouple(stickyId, pairId): StickyNote | undefined {
      return stmtGetStickyForCouple.get(stickyId, pairId) as StickyNote | undefined;
    },

    listWallStickies(pairId, limit): StickyNote[] {
      return stmtListWallStickies.all(pairId, limit) as StickyNote[];
    },

    listCommittedBlocksForStickies(stickyIds): StickyBlock[] {
      if (stickyIds.length === 0) return [];
      // Build placeholders for IN(...) — stickyIds count is bounded by the
      // wall query's LIMIT (route caps at 200), so we don't worry about
      // SQLITE_MAX_VARIABLE_NUMBER. Each placeholder is a real bind, no string
      // interpolation of user data.
      const placeholders = stickyIds.map(() => '?').join(',');
      const stmt = db.prepare(
        `SELECT * FROM sticky_blocks WHERE status = 'committed' AND sticky_id IN (${placeholders}) ORDER BY committed_at ASC, id ASC`
      );
      return stmt.all(...stickyIds) as StickyBlock[];
    },

    listSeenForStickies(userId, stickyIds): Map<number, number> {
      const out = new Map<number, number>();
      if (stickyIds.length === 0) return out;
      const placeholders = stickyIds.map(() => '?').join(',');
      const stmt = db.prepare(
        `SELECT sticky_id, last_seen_block_id FROM sticky_seen WHERE user_id = ? AND sticky_id IN (${placeholders})`
      );
      const rows = stmt.all(userId, ...stickyIds) as { sticky_id: number; last_seen_block_id: number }[];
      for (const r of rows) out.set(r.sticky_id, r.last_seen_block_id);
      return out;
    },

    maxCommittedBlockIdOnSticky(stickyId): number {
      const row = stmtMaxCommittedBlockIdOnSticky.get(stickyId) as { m: number };
      return row?.m ?? 0;
    },

    getTempBlock(stickyId, authorId): StickyBlock | undefined {
      return stmtGetTempBlock.get(stickyId, authorId) as StickyBlock | undefined;
    },

    createTempBlock(stickyId, authorId): StickyBlock {
      const result = stmtInsertTempBlock.run(stickyId, authorId);
      return stmtGetBlockById.get(Number(result.lastInsertRowid)) as StickyBlock;
    },

    updateTempBlockContent(stickyId, authorId, content): boolean {
      const result = stmtUpdateTempBlockContent.run(content, stickyId, authorId);
      return result.changes > 0;
    },

    deleteTempBlock(stickyId, authorId): boolean {
      const result = stmtDeleteTempBlock.run(stickyId, authorId);
      return result.changes > 0;
    },

    commitBlock(stickyId, authorId, content): StickyBlock | null {
      const blockRotation = pickBlockRotation();
      const result = stmtCommitBlock.run(content, blockRotation, stickyId, authorId);
      if (result.changes === 0) return null;
      // After commit the row is no longer 'temp', so re-fetch by (sticky,
      // author) for the most-recent committed block authored here.
      const block = db.prepare(
        "SELECT * FROM sticky_blocks WHERE sticky_id = ? AND author_id = ? AND status = 'committed' ORDER BY id DESC LIMIT 1"
      ).get(stickyId, authorId) as StickyBlock | undefined;
      return block ?? null;
    },

    markStickySeen(userId, stickyId, blockId): void {
      stmtUpsertStickySeen.run(userId, stickyId, blockId);
    },

    deleteSticky(stickyId, userId, partnerId): boolean {
      return db.transaction(() => {
        const sticky = stmtGetStickyForCouple.get(
          stickyId, userId, partnerId, partnerId, userId
        ) as StickyNote | undefined;
        if (!sticky || sticky.status !== 'posted') return false;
        stmtDeleteStickyBlocks.run(stickyId);
        stmtDeleteStickySeenRows.run(stickyId);
        stmtDeleteStickyNote.run(stickyId);
        return true;
      })();
    },

    deleteCommittedBlock(stickyId, blockId, authorId): { ok: boolean; reason?: 'not_found' | 'first_block' } {
      return db.transaction(() => {
        const block = stmtGetBlockById.get(blockId) as StickyBlock | undefined;
        if (
          !block ||
          block.sticky_id !== stickyId ||
          block.author_id !== authorId ||
          block.status !== 'committed'
        ) {
          return { ok: false, reason: 'not_found' as const };
        }
        const first = stmtFirstCommittedBlockId.get(stickyId) as { id: number } | undefined;
        if (first?.id === blockId) {
          return { ok: false, reason: 'first_block' as const };
        }
        const result = stmtDeleteCommittedBlockById.run(blockId, stickyId, authorId);
        if (result.changes === 0) return { ok: false, reason: 'not_found' as const };
        return { ok: true };
      })();
    },
  };

  return { db, dbOps };
}

// Default instance for production
const defaultInstance = createDatabase();

export const dbOps = defaultInstance.dbOps;
const db: DatabaseType = defaultInstance.db;
export default db;
