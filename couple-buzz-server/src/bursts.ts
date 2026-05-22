// v1.3.1 — server-side burst tracker for 废话区 emoji pushes.
//
// Why: each /api/action POST currently fires its own APNs notification.
// When user A spams the same emoji at user B, B's lock screen stacks
// up N separate banners — noisy, drowns out anything else B might
// have unread. We mirror v1.2.20's client-side ×NN bubble collapse
// (same 5-min rolling window) onto the push pipeline:
//
//   1. Each /api/action call increments an in-memory counter keyed by
//      (recipient, sender, action_type).
//   2. The counter shares a single APNs collapse-id across the whole
//      burst, so iOS replaces the prior lock-screen entry instead of
//      stacking. Net result: ONE notification per burst, body shows
//      "...  ×N" so the user sees the running count.
//
// Counter is in-memory only. Process restart resets it (the next emoji
// looks like the start of a fresh burst — minor cosmetic glitch, no
// real impact since the chat bubble re-renders correctly from DB).

const BURST_WINDOW_MS = 5 * 60 * 1000;

interface BurstState {
  count: number;
  startedAt: number;
  lastAt: number;
  collapseId: string;
}

const bursts = new Map<string, BurstState>();

function key(recipientId: string, senderId: string, actionType: string): string {
  return `${recipientId}:${senderId}:${actionType}`;
}

export function trackBurst(
  recipientId: string,
  senderId: string,
  actionType: string,
): BurstState {
  const k = key(recipientId, senderId, actionType);
  const now = Date.now();
  const existing = bursts.get(k);
  if (existing && now - existing.lastAt <= BURST_WINDOW_MS) {
    existing.count += 1;
    existing.lastAt = now;
    return existing;
  }
  // Fresh burst. collapseId is stable for the whole burst (no `now`
  // suffix would let an out-of-window stale entry collide with a new
  // burst on the device — so we DO append `now` to disambiguate).
  const fresh: BurstState = {
    count: 1,
    startedAt: now,
    lastAt: now,
    collapseId: `burst-${k}-${now}`,
  };
  bursts.set(k, fresh);
  return fresh;
}

// Background GC — drops entries whose burst window has long-expired so
// the Map doesn't grow unboundedly over a long-running server. Runs
// every 60 s; cheap O(n) scan. .unref() so the timer doesn't keep the
// event loop alive in tests.
const gcInterval = setInterval(() => {
  const cutoff = Date.now() - BURST_WINDOW_MS - 60_000;
  for (const [k, v] of bursts.entries()) {
    if (v.lastAt < cutoff) bursts.delete(k);
  }
}, 60_000);
if (typeof gcInterval.unref === 'function') gcInterval.unref();

// Test-only helper — clears burst state between jest runs so per-test
// state doesn't bleed across (the Map otherwise persists across
// `createTestApp()` calls within the same suite).
export function _resetBurstsForTesting(): void {
  bursts.clear();
}
