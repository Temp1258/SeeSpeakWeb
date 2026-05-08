import { API_URL } from '../constants';
import { storage } from '../utils/storage';
import { getDeviceInfo } from '../utils/device';

// Thrown only when the server has definitively rejected the session
// (401 even after a refresh attempt). Network failures, DNS errors,
// 5xx responses, and wrong API URLs throw plain Error — callers must
// not treat those as "user is logged out".
export class AuthError extends Error {
  // `code` lets the UI distinguish a force-logout from another device
  // ("session_revoked") from a generic auth failure (refresh-token
  // expired naturally, password changed, etc). App.tsx swaps the
  // re-login screen's headline based on this.
  code?: string;
  constructor(message = 'Authentication failed', code?: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

// Three-state outcome:
//   'success'  — new tokens persisted, retry should succeed
//   'auth'     — server explicitly rejected the refresh token (401/403/4xx)
//                or none was stored. Caller throws AuthError → user re-logs in.
//   'transient'— network failure, 5xx, or malformed response. Caller treats
//                this as a normal request failure and does NOT log out — a
//                Wi-Fi blip on cold launch must not boot a logged-in user.
// `auth-revoked` is a stricter form of `auth` — the server told us the
// session was force-logged-out from another device, so the UI message
// should reflect that instead of the generic "you've been signed out".
type RefreshOutcome = 'success' | 'auth' | 'auth-revoked' | 'transient';

// Default network timeout. Without this, RN's fetch can hang indefinitely
// on weak networks (subway, elevator, transient TLS stalls), leaving the UI
// stuck in a loading state until the user kills the app. 15s covers all
// normal API endpoints; uploads pass a longer timeout explicitly.
const DEFAULT_TIMEOUT_MS = 15000;
const UPLOAD_TIMEOUT_MS = 30000;

function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(id));
}

// Decode the JWT exp claim (no verification — we only use it to *predict*
// expiry locally). Returns 0 on any decode failure; 0 → caller skips the
// proactive refresh and lets the normal 401 path handle it.
function jwtExpMs(token: string): number {
  try {
    const part = token.split('.')[1];
    if (!part) return 0;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const payload = JSON.parse(json);
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// Refresh-window lead. The access token lives 15min; refreshing 60s before
// expiry lets us avoid the "send body, get 401, send body again" double
// upload that happens when a request races a stale-token boundary. Larger
// values waste fewer bytes; smaller values reduce churn. 60s is generous
// enough to swallow normal RTT variance.
const PROACTIVE_REFRESH_LEAD_MS = 60_000;

// Refresh proactively when the access token is near expiry. Cheap when the
// token is still fresh (one storage read + JWT decode); when stale, shares
// the singleton refresh promise so multiple parallel callers collapse into
// a single network round-trip. Safe to call before every authed request.
async function ensureFreshToken(): Promise<void> {
  const t = await storage.getAccessToken();
  if (!t) return;
  const exp = jwtExpMs(t);
  if (exp === 0) return;
  if (exp - Date.now() < PROACTIVE_REFRESH_LEAD_MS) {
    await refreshAccessToken();
  }
}

// Singleton-promise lock: when several requests hit a 401 in parallel, they
// all `await` the same in-flight refresh instead of the second-onward giving
// up immediately and bubbling the original 401 into an AuthError (which
// would falsely log the user out).
let refreshPromise: Promise<RefreshOutcome> | null = null;

async function refreshAccessToken(): Promise<RefreshOutcome> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async (): Promise<RefreshOutcome> => {
    try {
      const refreshToken = await storage.getRefreshToken();
      if (!refreshToken) return 'auth';

      let res: Response;
      try {
        res = await fetchWithTimeout(`${API_URL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      } catch {
        // DNS/network/TLS failure / timeout — the refresh token may still
        // be valid; do NOT log the user out.
        return 'transient';
      }

      if (res.ok) {
        const data = await res.json();
        // Atomic write — see storage.setTokens for why two-step setItem
        // would be unsafe (a kill between writes leaves OLD_REFRESH that's
        // already been rotated server-side, locking the user out).
        await storage.setTokens(data.access_token, data.refresh_token);
        return 'success';
      }

      // Only 401/403 are real "this refresh token is rejected" signals.
      // 429 (rate limit) and 400 (e.g. transient malformed-body edge case)
      // and 5xx are all treated as transient — we must NOT log the user
      // out for a rate-limited refresh: that would loop them back to
      // SetupScreen the moment the auth limiter saturated.
      if (res.status === 401 || res.status === 403) {
        try {
          const body = await res.json();
          if (body?.code === 'session_revoked') return 'auth-revoked';
        } catch {}
        return 'auth';
      }
      return 'transient';
    } catch {
      return 'transient';
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function request<T>(path: string, options: RequestInit = {}, requiresAuth = true): Promise<T> {
  // Proactive refresh: avoid the wasteful "send body → get 401 → refresh →
  // send body again" round-trip whenever the local token is already known
  // to be near expiry. The 401 path below stays as a safety net for token
  // revocation from another device or server clock drift.
  if (requiresAuth) await ensureFreshToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (requiresAuth) {
    const token = await storage.getAccessToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_URL}${path}`, { ...options, headers });
  } catch {
    // Timeout / DNS / TLS failure — surface as a generic transient error
    // so callers don't conflate it with an auth problem.
    throw new Error('Network error');
  }

  // Auto-refresh on 401
  if (res.status === 401 && requiresAuth) {
    const outcome = await refreshAccessToken();
    if (outcome === 'auth-revoked') throw new AuthError('Session revoked', 'session_revoked');
    if (outcome === 'success') {
      const newToken = await storage.getAccessToken();
      headers['Authorization'] = `Bearer ${newToken}`;
      try {
        res = await fetchWithTimeout(`${API_URL}${path}`, { ...options, headers });
      } catch {
        throw new Error('Network error');
      }
      // If the retry still 401s, the new token was already revoked — that's
      // a real auth failure.
      if (res.status === 401) throw new AuthError();
    } else if (outcome === 'auth') {
      // Server explicitly rejected the refresh token — re-login required.
      throw new AuthError();
    } else {
      // Transient: refresh couldn't complete because of network/5xx. Surface
      // the original 401 as a normal Error so callers retry next time
      // instead of clearing the session.
      throw new Error('Network error');
    }
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Server error (${res.status})`);
  }

  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data as T;
}

export interface RegisterResponse {
  user_id: string;
  access_token: string;
  refresh_token: string;
}

export interface LoginResponse {
  user_id: string;
  name: string;
  partner_name: string | null;
  access_token: string;
  refresh_token: string;
}

export interface PairResponse {
  success: boolean;
  partner_name: string;
}

export interface StatusResponse {
  paired: boolean;
  partner_id?: string;
  partner_name?: string;
  // Stable 10-char relationship handle (e.g. "KMRPQT4729"). Surfaced in
  // Settings as the couple's "ID". Persists across unpair/repair within
  // the 90-day TTL.
  pair_id?: string | null;
  name: string;
  timezone: string;
  partner_timezone: string;
  partner_remark: string;
  streak: number;
}

export interface ActionResponse {
  success: boolean;
}

export interface ProfileResponse {
  success: boolean;
  name: string;
  timezone: string;
  partner_timezone: string;
  partner_remark: string;
}

export interface HistoryAction {
  id: number;
  user_id: string;
  user_name: string;
  action_type: string;
  sender_timezone: string;
  reply_to?: number | null;
  created_at: string;
}

export interface HistoryResponse {
  actions: HistoryAction[];
  reactions: Record<number, HistoryAction[]>;
  last_read_action_id?: number;
}

export interface ReactionResponse {
  success: boolean;
  reaction_id: number;
}

export interface WsTicketResponse {
  ticket: string;
  expires_in: number;
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

export interface DatesResponse {
  dates: ImportantDate[];
  pinned: { title: string; date: string; days_away: number; days_diff: number } | null;
}

export interface DailyQuestionResponse {
  question: string;
  question_index: number;
  date: string;
  my_answer: string | null;
  partner_answer: string | null;
  partner_answered: boolean;
  both_answered: boolean;
  my_reaction_to_partner: 'up' | 'down' | null;
  partner_reaction_to_me: 'up' | 'down' | null;
}

export interface StatsResponse {
  total_actions: number;
  my_actions: number;
  partner_actions: number;
  top_actions: { action_type: string; count: number }[];
  hourly: { hour: number; count: number }[];
  monthly: { month: string; count: number }[];
  first_action_date: string | null;
}

export interface DailyAnswerResponse {
  success: boolean;
  both_answered: boolean;
  partner_answer: string | null;
}

export interface RitualStatusResponse {
  local_hour: number;
  morning: { my_completed: boolean; partner_completed: boolean; both_completed: boolean };
  evening: { my_completed: boolean; partner_completed: boolean; both_completed: boolean };
  daily_recap: { total_interactions: number; top_action: string | null } | null;
}

export interface RitualResponse {
  success: boolean;
  ritual_type: string;
  ritual_date: string;
  both_completed: boolean;
}

export interface MailboxResponse {
  week_key: string;
  phase: 'writing' | 'revealed';
  // In writing phase the server hides own content (sealed in transit). Use
  // `my_sealed` to know whether the user already submitted this round.
  my_message: string | null;
  my_sealed: boolean;
  partner_message: string | null;
  partner_wrote?: boolean;
  reveal_at: string;
  can_edit: boolean;
}

export interface MailboxArchiveResponse {
  weeks: {
    week_key: string;
    my_content: string | null;
    partner_content: string | null;
    // Server returns the partner mailbox row's PK so the inbox can reference
    // a specific letter for trash / restore / purge actions. May be null when
    // partner skipped the round or the message has been trashed/purged.
    partner_message_id: number | null;
    // ISO timestamp of when the partner submitted their letter — drives the
    // "GMT+8 04-27 20:00" stamp shown in the inbox card. Null = partner
    // skipped the round (or message trashed).
    partner_created_at: string | null;
  }[];
}

// Sender-side view of mail in transit. Mailbox letters disappear from
// pending once the session reveals; capsules drop off once `unlock_at`
// elapses.
export interface OutboxMailboxItem {
  id: number;
  week_key: string;
  content: string;
  created_at: string;
  reveal_at: string;
}
export interface OutboxCapsuleItem {
  id: number;
  content: string;
  unlock_date: string;
  unlock_at: string;
  visibility: 'self' | 'partner';
  created_at: string;
}
export interface OutboxResponse {
  mailbox_pending: OutboxMailboxItem[];
  capsule_pending: OutboxCapsuleItem[];
  // True iff at least one pending letter was queued after the user's
  // server-stored "outbox last seen" marker. Drives 🚩 / tab dot.
  has_fresh: boolean;
}

export interface TrashedInboxItem {
  kind: 'mailbox' | 'capsule';
  ref_id: number;
  date: string;
  content: string;
  author: 'me' | 'partner';
  visibility: 'self' | 'partner';
  trashed_at: string;
}

export interface WeeklyReportResponse {
  week_key: string;
  total: number;
  last_week_total: number;
  change_percent: number;
  my_count: number;
  partner_count: number;
  streak: number;
  top_actions: { action_type: string; count: number }[];
  daily_question_rate: string;
  ritual_morning_rate: string;
  ritual_evening_rate: string;
  temperature: number;
  temperature_label: string;
}

export interface CapsuleItem {
  id: number;
  author: 'me' | 'partner';
  content: string | null;
  unlock_date: string;
  // Full ISO unlock instant (UTC, minute precision). Computed on the client
  // from the sender's tz-aware date+time picker.
  unlock_at: string;
  is_unlockable: boolean;
  opened_at: string | null;
  visibility: 'self' | 'partner';
  created_at: string;
}

export interface BucketItemResponse {
  id: number;
  user_id: string;
  partner_id: string;
  title: string;
  category: string | null;
  completed: number;
  completed_by: string | null;
  completed_at: string | null;
  created_by: string;
  created_at: string;
}

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

export interface SnapTodayResponse {
  snap_date: string;
  my_snapped: boolean;
  partner_snapped: boolean;
  my_photo: string | null;
  partner_photo: string | null;
  my_reaction_to_partner: 'up' | 'down' | null;
  partner_reaction_to_me: 'up' | 'down' | null;
}

export interface SnapMonth {
  date: string;
  my_photo: string | null;
  partner_photo: string | null;
  both_snapped: boolean;
}

// 每日一帖 — wall response shape. The server normalizes author identity to
// 'me' | 'partner' relative to the requester, so the UI doesn't compare ids.
export interface StickyBlockView {
  id: number;
  author_role: 'me' | 'partner';
  content: string;
  committed_at: string | null;
  // Each block renders as its own paper in the sticky's "stapled stack" with
  // an independent tilt — server picks at commit time so both clients see
  // the same scattered arrangement.
  layout_rotation: number;
}

export interface StickyView {
  id: number;
  author_role: 'me' | 'partner';
  layout_x: number;
  layout_rotation: number;
  posted_at: string;
  unread: boolean;
  blocks: StickyBlockView[];
  my_temp_block: { content: string } | null;
}

export interface StickyTemp {
  sticky_id: number;
  content: string;
  created_at: string;
}

export interface StickyWallResponse {
  stickies: StickyView[];
  my_temp: StickyTemp | null;
}

export interface StickyPostResponse {
  sticky_id: number;
  block_id: number;
  layout_x: number;
  layout_rotation: number;
  posted_at: string;
}

// Imported from utils/timezone (re-exported below for callers that
// expect the symbol on the api module surface). The shared cache means
// repeated API calls don't pay the Intl lookup cost each time.
import { getDeviceTimezone } from '../utils/timezone';
export { getDeviceTimezone };

export const api = {
  register(name: string, password: string): Promise<RegisterResponse> {
    return request('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        name,
        password,
        timezone: getDeviceTimezone(),
        device: getDeviceInfo(),
      }),
    }, false);
  },

  login(userId: string, password: string): Promise<LoginResponse> {
    return request('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        password,
        device: getDeviceInfo(),
      }),
    }, false);
  },

  pair(partnerId: string): Promise<PairResponse> {
    return request('/api/pair', {
      method: 'POST',
      body: JSON.stringify({ partner_id: partnerId }),
    });
  },

  unpair(): Promise<{ success: boolean; new_pair_code: string }> {
    return request('/api/unpair', { method: 'POST' });
  },

  getStatus(): Promise<StatusResponse> {
    return request('/api/status');
  },

  sendAction(actionType: string): Promise<ActionResponse> {
    return request('/api/action', {
      method: 'POST',
      body: JSON.stringify({ action_type: actionType, timezone: getDeviceTimezone() }),
    });
  },

  getHistory(limit = 50): Promise<HistoryResponse> {
    return request(`/api/history?limit=${limit}`);
  },

  markRead(lastId: number): Promise<{ success: boolean; unread: number }> {
    return request('/api/mark-read', {
      method: 'POST',
      body: JSON.stringify({ last_id: lastId }),
    });
  },

  sendReaction(actionId: number, actionType: string): Promise<ReactionResponse> {
    return request('/api/reaction', {
      method: 'POST',
      body: JSON.stringify({ action_id: actionId, action_type: actionType }),
    });
  },

  getWsTicket(): Promise<WsTicketResponse> {
    return request('/api/ws-ticket');
  },

  updateToken(deviceToken: string): Promise<{ success: boolean }> {
    return request('/api/device-token', {
      method: 'PUT',
      body: JSON.stringify({ device_token: deviceToken }),
    });
  },

  updateProfile(name: string, timezone: string, partnerTimezone: string, partnerRemark: string): Promise<ProfileResponse> {
    return request('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({ name, timezone, partner_timezone: partnerTimezone, partner_remark: partnerRemark }),
    });
  },

  getDates(): Promise<DatesResponse> {
    return request('/api/dates');
  },

  createDate(title: string, date: string, recurring: boolean): Promise<{ date: ImportantDate }> {
    return request('/api/dates', {
      method: 'POST',
      body: JSON.stringify({ title, date, recurring }),
    });
  },

  deleteDate(id: number): Promise<{ success: boolean }> {
    return request(`/api/dates/${id}`, { method: 'DELETE' });
  },

  pinDate(id: number): Promise<{ success: boolean }> {
    return request(`/api/dates/${id}/pin`, { method: 'POST' });
  },

  getDailyQuestion(): Promise<DailyQuestionResponse> {
    return request('/api/daily-question');
  },

  submitDailyAnswer(answer: string): Promise<DailyAnswerResponse> {
    return request('/api/daily-question/answer', {
      method: 'POST',
      body: JSON.stringify({ answer }),
    });
  },

  getStats(): Promise<StatsResponse> {
    return request('/api/stats');
  },

  getRitualStatus(): Promise<RitualStatusResponse> {
    return request('/api/ritual/status');
  },

  submitRitual(type: 'morning' | 'evening'): Promise<RitualResponse> {
    return request('/api/ritual', {
      method: 'POST',
      body: JSON.stringify({ ritual_type: type }),
    });
  },

  getMailbox(): Promise<MailboxResponse> {
    return request('/api/mailbox');
  },

  submitMailbox(content: string): Promise<{ success: boolean }> {
    return request('/api/mailbox', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  },

  getMailboxArchive(limit = 10): Promise<MailboxArchiveResponse> {
    return request(`/api/mailbox/archive?limit=${limit}`);
  },

  getOutbox(): Promise<OutboxResponse> {
    return request('/api/outbox');
  },
  // Advance the server-stored outbox-seen marker — called from
  // OutboxScreen close so the 🚩 stays off until the next send.
  markOutboxSeen(): Promise<{ success: boolean }> {
    return request('/api/outbox/seen', { method: 'POST' });
  },

  getWeeklyReport(week?: string): Promise<WeeklyReportResponse> {
    return request(`/api/weekly-report${week ? `?week=${week}` : ''}`);
  },

  createCapsule(content: string, unlockDate: string, unlockAt: string, visibility: 'self' | 'partner'): Promise<{ id: number }> {
    return request('/api/capsules', { method: 'POST', body: JSON.stringify({ content, unlock_date: unlockDate, unlock_at: unlockAt, visibility }) });
  },
  getCapsules(): Promise<{ capsules: CapsuleItem[] }> {
    return request('/api/capsules');
  },
  openCapsule(id: number): Promise<{ success: boolean; content: string }> {
    return request(`/api/capsules/${id}/open`, { method: 'POST' });
  },

  trashInboxItem(kind: 'mailbox' | 'capsule', refId: number): Promise<{ success: boolean }> {
    return request('/api/inbox/trash', { method: 'POST', body: JSON.stringify({ kind, ref_id: refId }) });
  },
  restoreInboxItem(kind: 'mailbox' | 'capsule', refId: number): Promise<{ success: boolean }> {
    return request('/api/inbox/restore', { method: 'POST', body: JSON.stringify({ kind, ref_id: refId }) });
  },
  purgeInboxItem(kind: 'mailbox' | 'capsule', refId: number): Promise<{ success: boolean }> {
    return request('/api/inbox/purge', { method: 'POST', body: JSON.stringify({ kind, ref_id: refId }) });
  },
  getInboxTrash(): Promise<{ items: TrashedInboxItem[] }> {
    return request('/api/inbox/trash');
  },

  getBucket(): Promise<{ items: BucketItemResponse[]; total: number; completed_count: number }> {
    return request('/api/bucket');
  },
  createBucketItem(title: string, category?: string): Promise<{ item: BucketItemResponse }> {
    return request('/api/bucket', { method: 'POST', body: JSON.stringify({ title, category }) });
  },
  completeBucketItem(id: number): Promise<{ success: boolean }> {
    return request(`/api/bucket/${id}/complete`, { method: 'POST' });
  },
  uncompleteBucketItem(id: number): Promise<{ success: boolean }> {
    return request(`/api/bucket/${id}/uncomplete`, { method: 'POST' });
  },
  deleteBucketItem(id: number): Promise<{ success: boolean }> {
    return request(`/api/bucket/${id}`, { method: 'DELETE' });
  },

  getSnapToday(): Promise<SnapTodayResponse> {
    return request('/api/snaps/today');
  },
  getSnaps(month: string): Promise<{ snaps: SnapMonth[] }> {
    return request(`/api/snaps?month=${month}`);
  },

  // Multipart upload with the same 401→refresh→retry safety as `request()`.
  // Bypassing `request()` (which sets Content-Type: application/json) is
  // necessary because RN's fetch needs to pick its own multipart boundary.
  // Without 401 retry here, the user would see "上传失败" the first time
  // their access_token expires (every 15min) until they restart the app.
  async uploadSnap(uri: string): Promise<{ success: boolean; both_snapped: boolean; snap_date: string }> {
    const tryUpload = async (): Promise<Response> => {
      const token = await storage.getAccessToken();
      const fd = new FormData();
      fd.append('photo', { uri, type: 'image/jpeg', name: 'snap.jpg' } as any);
      return fetchWithTimeout(`${API_URL}/api/snaps`, {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        body: fd,
      }, UPLOAD_TIMEOUT_MS);
    };

    // Proactive refresh ensures the first attempt uses a fresh token —
    // matters more here than for JSON requests because re-uploading a
    // multipart body costs real bytes and can exceed UPLOAD_TIMEOUT_MS
    // on a slow link.
    await ensureFreshToken();

    let res: Response | null = null;
    let firstThrew = false;
    try {
      res = await tryUpload();
    } catch {
      firstThrew = true;
    }

    // Catch fallback: an HTTP/2 mid-stream 401 from nginx can surface in
    // NSURLSession as a network error rather than a Response with status
    // 401. If proactive refresh missed (clock skew / token version bumped
    // by another device's force-logout / refresh raced), we still need
    // one more shot before giving up — otherwise the user just sees
    // "Network error" with no auto-recovery.
    if (firstThrew) {
      const outcome = await refreshAccessToken();
      if (outcome === 'auth-revoked') throw new AuthError('Session revoked', 'session_revoked');
      if (outcome === 'auth') throw new AuthError();
      if (outcome !== 'success') throw new Error('Network error');
      try {
        res = await tryUpload();
      } catch {
        throw new Error('Network error');
      }
    }

    if (res!.status === 401) {
      const outcome = await refreshAccessToken();
      if (outcome === 'success') {
        try {
          res = await tryUpload();
        } catch {
          throw new Error('Network error');
        }
        if (res.status === 401) throw new AuthError();
      } else if (outcome === 'auth-revoked') {
        throw new AuthError('Session revoked', 'session_revoked');
      } else if (outcome === 'auth') {
        throw new AuthError();
      } else {
        throw new Error('Network error');
      }
    }

    let data: any;
    try {
      data = await res!.json();
    } catch {
      throw new Error(`Server error (${res!.status})`);
    }
    if (!res!.ok) throw new Error(data.error || '上传失败');
    return data;
  },

  urge(type: 'question' | 'snap'): Promise<{ success: boolean }> {
    return request('/api/urge', { method: 'POST', body: JSON.stringify({ type }) });
  },
  dailyReaction(type: 'question' | 'snap', reaction: 'up' | 'down'): Promise<{ success: boolean; reaction: 'up' | 'down' }> {
    return request('/api/daily-reaction', { method: 'POST', body: JSON.stringify({ type, reaction }) });
  },

  // Per-user "seen" markers + draft, server-stored so they sync across
  // devices for the same account. (Step 4)
  getDailySeen(): Promise<{ date: string | null; pa: boolean; ps: boolean }> {
    return request('/api/daily/seen');
  },
  setDailySeen(date: string, pa: boolean, ps: boolean): Promise<{ success: boolean }> {
    return request('/api/daily/seen', { method: 'POST', body: JSON.stringify({ date, pa, ps }) });
  },
  getInboxSeen(): Promise<{ seen_at: string | null }> {
    return request('/api/inbox/seen');
  },
  markInboxSeen(): Promise<{ success: boolean }> {
    return request('/api/inbox/seen', { method: 'POST' });
  },
  getLetterDraft(): Promise<{ draft: string }> {
    return request('/api/letter-draft');
  },
  setLetterDraft(draft: string): Promise<{ success: boolean }> {
    return request('/api/letter-draft', { method: 'PUT', body: JSON.stringify({ draft }) });
  },

  // Sessions / multi-device login.
  listSessions(): Promise<{ sessions: SessionView[] }> {
    return request('/api/sessions');
  },
  // Promote the named session to primary. Server-side guard: only the
  // current primary can transfer primary to a different session.
  promoteSession(sessionId: string): Promise<{ success: boolean }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/primary`, { method: 'POST' });
  },
  // Force-logout. Self-revoke always allowed; revoking another session
  // requires the requester to be primary (server enforces; we mirror in
  // the UI by hiding the action on non-primary devices).
  revokeSession(sessionId: string): Promise<{ success: boolean }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  },
  // Atomic group revoke — drops every session sharing the target's
  // (device_name, device_os). Required because parallel single-session
  // DELETEs race the auth middleware: revoking our own row first kills
  // sibling DELETEs with 401, leaving the rest of the group active.
  revokeSessionGroup(sessionId: string): Promise<{ success: boolean; revoked_count: number }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/group`, { method: 'DELETE' });
  },
  // Rename the device label. Server propagates to every active session
  // sharing the same (device_name, device_os) so the dedup grouping in
  // DeviceListCard stays one row per physical device after the edit.
  renameSession(sessionId: string, name: string): Promise<{ success: boolean }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/name`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });
  },
  logout(): Promise<{ success: boolean }> {
    return request('/api/logout', { method: 'POST' });
  },

  // 每日一帖 (sticky notes)
  getStickies(): Promise<StickyWallResponse> {
    return request('/api/stickies');
  },
  startStickyTemp(): Promise<StickyTemp> {
    return request('/api/stickies/temp', { method: 'POST' });
  },
  saveStickyTemp(content: string): Promise<{ success: boolean }> {
    return request('/api/stickies/temp', { method: 'PUT', body: JSON.stringify({ content }) });
  },
  cancelStickyTemp(): Promise<{ success: boolean }> {
    return request('/api/stickies/temp', { method: 'DELETE' });
  },
  postSticky(content: string): Promise<StickyPostResponse> {
    return request('/api/stickies/temp/post', { method: 'POST', body: JSON.stringify({ content }) });
  },
  startStickyComment(stickyId: number): Promise<{ block_id: number; content: string }> {
    return request(`/api/stickies/${stickyId}/blocks/temp`, { method: 'POST' });
  },
  saveStickyComment(stickyId: number, content: string): Promise<{ success: boolean }> {
    return request(`/api/stickies/${stickyId}/blocks/temp`, { method: 'PUT', body: JSON.stringify({ content }) });
  },
  cancelStickyComment(stickyId: number): Promise<{ success: boolean }> {
    return request(`/api/stickies/${stickyId}/blocks/temp`, { method: 'DELETE' });
  },
  commitStickyComment(stickyId: number, content: string): Promise<{ block_id: number; content: string; committed_at: string }> {
    return request(`/api/stickies/${stickyId}/blocks/commit`, { method: 'POST', body: JSON.stringify({ content }) });
  },
  markStickySeen(stickyId: number): Promise<{ success: boolean; last_seen_block_id: number }> {
    return request(`/api/stickies/${stickyId}/seen`, { method: 'POST' });
  },
  deleteSticky(stickyId: number): Promise<{ success: boolean }> {
    return request(`/api/stickies/${stickyId}`, { method: 'DELETE' });
  },
  deleteStickyBlock(stickyId: number, blockId: number): Promise<{ success: boolean }> {
    return request(`/api/stickies/${stickyId}/blocks/${blockId}`, { method: 'DELETE' });
  },
};
