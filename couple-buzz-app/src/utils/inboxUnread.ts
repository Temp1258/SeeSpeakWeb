import { api } from '../services/api';

// Mailbox letter "arrived" at the session reveal time. AM session reveals at
// 12:00 UTC of the date; PM at next-day 0:00 UTC. Mirrors server's
// getRevealTime() so the client can compute without a round-trip.
export function mailboxRevealTime(weekKey: string): string {
  const date = weekKey.slice(0, 10);
  const phase = weekKey.slice(11);
  if (phase === 'AM') return `${date}T12:00:00Z`;
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

// SQLite's CURRENT_TIMESTAMP serializes as "YYYY-MM-DD HH:MM:SS" — no T, no
// timezone. Date parsing of this format is implementation-defined (works in
// Node, brittle in Hermes / older Safari). Normalize to proper ISO-Z so
// downstream Date operations and lexicographic comparisons are stable.
export function normalizeIso(s: string | null | undefined): string {
  if (!s) return '';
  if (s.includes('T') && (/Z$/.test(s) || /[+-]\d\d:?\d\d$/.test(s))) return s;
  return `${s.replace(' ', 'T')}Z`;
}

// True iff inbox has at least one letter (mailbox archive or opened capsule)
// that arrived after the user's last visit. Used to drive the red flag on the
// inbox row in MailboxScreen. First-ever launch returns false — without a
// stored marker, every historical letter would otherwise look "new".
export async function hasUnreadInboxItems(): Promise<boolean> {
  try {
    const [seenResp, mailbox, capsules] = await Promise.all([
      api.getInboxSeen().catch(() => ({ seen_at: null })),
      api.getMailboxArchive(50).catch(() => ({ weeks: [] as any[] })),
      api.getCapsules().catch(() => ({ capsules: [] as any[] })),
    ]);
    const seen = seenResp.seen_at;
    if (!seen) return false;

    for (const w of mailbox.weeks || []) {
      if (!w.partner_content || !w.partner_message_id) continue;
      if (mailboxRevealTime(w.week_key) > seen) return true;
    }
    for (const c of capsules.capsules || []) {
      if (!c.opened_at || !c.content) continue;
      // Capsule the user wrote for partner — never their own "new mail".
      if (c.author === 'me' && c.visibility === 'partner') continue;
      if (normalizeIso(c.opened_at) > seen) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// True iff the outbox holds at least one pending letter that was queued
// after the user's server-side `outbox_last_seen` marker. Drives the
// outbox 🚩 in MailboxScreen and the 信箱 tab red dot post-send.
//
// Marker lives on the server so that logout / clearAll / reinstall can't
// silently lose it: if the user wrote a letter on Tuesday and never opened
// the outbox before Wednesday's logout, they reinstall on Friday and the
// 🚩 still surfaces. The marker only advances when the user actively
// opens OutboxScreen.
export async function hasFreshOutboxItems(): Promise<boolean> {
  try {
    const outbox = await api.getOutbox().catch(() => null);
    return outbox?.has_fresh ?? false;
  } catch {
    return false;
  }
}
