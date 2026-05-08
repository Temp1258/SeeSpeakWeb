import { DbOps } from './db';
import { pushToUser, type SendPushFn } from './push';

// Per-event dedup keyed by the UTC day the event fires on.
// Kept in-memory: a process restart within the trigger minute may retrigger
// an event, but that's preferable to missing it after a deploy.
const lastTriggered: Record<string, string> = {};

export function startScheduler(dbOps: DbOps, pushFn: SendPushFn): void {
  setInterval(async () => {
    const now = new Date();
    const utcDay = now.getUTCDay(); // 0=Sun ... 5=Fri 6=Sat
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    const dayKey = now.toISOString().slice(0, 10);

    const fireOnce = async (name: string, run: () => Promise<void>) => {
      const key = `${name}:${dayKey}`;
      if (lastTriggered[name] === key) return;
      lastTriggered[name] = key;
      try {
        await run();
      } catch (err) {
        console.warn(`[Scheduler] ${name} failed:`, err);
      }
    };

    // Mailbox sessions are 12h: AM (0:00-11:59 UTC = 8am-7:59pm BJT) and
    // PM (12:00-23:59 UTC = 8pm BJT - 7:59am next day BJT).

    // 0:00 UTC daily (= 8am BJT): PM session reveals + AM session opens
    if (utcHour === 0 && utcMin === 0) {
      await fireOnce('mailbox_reveal_pm', () => broadcastPush(dbOps, pushFn, 'mailbox_reveal'));
      await fireOnce('mailbox_open_am', () => broadcastPush(dbOps, pushFn, 'mailbox_open'));
    }

    // 11:45 UTC daily (= 7:45pm BJT): 15 min before AM session reveals
    if (utcHour === 11 && utcMin === 45) {
      await fireOnce('mailbox_countdown_am', () => broadcastPush(dbOps, pushFn, 'mailbox_countdown_15min'));
    }

    // 12:00 UTC daily (= 8pm BJT): AM session reveals + PM session opens
    if (utcHour === 12 && utcMin === 0) {
      await fireOnce('mailbox_reveal_am', () => broadcastPush(dbOps, pushFn, 'mailbox_reveal'));
      await fireOnce('mailbox_open_pm', () => broadcastPush(dbOps, pushFn, 'mailbox_open'));
    }

    // 23:45 UTC daily (= 7:45am BJT): 15 min before PM session reveals
    if (utcHour === 23 && utcMin === 45) {
      await fireOnce('mailbox_countdown_pm', () => broadcastPush(dbOps, pushFn, 'mailbox_countdown_15min'));
    }

    // Sunday 14:00 UTC — weekly report (unchanged)
    if (utcDay === 0 && utcHour === 14 && utcMin === 0) {
      await fireOnce('weekly_report', () => broadcastPush(dbOps, pushFn, 'weekly_report'));
    }

    // 03:00 UTC daily — TTL sweep for couples whose ended_at + 90d have
    // elapsed. Hard-deletes all data tagged with that pair_id. Cheap on
    // small datasets; idempotent (only matches still-expired rows).
    if (utcHour === 3 && utcMin === 0) {
      await fireOnce('couples_ttl_cleanup', async () => {
        const deleted = dbOps.couplesCleanupExpired();
        if (deleted.length > 0) {
          console.log(`[TTL] Hard-deleted ${deleted.length} expired couple(s): ${deleted.join(', ')}`);
        }
      });
    }

    // Capsule unlock pushes — fire every 5 minutes so the recipient gets
    // notified within ~5min of the picked unlock_at instant. The minute
    // bucket is part of the dedup key so each tick is a distinct event.
    if (utcMin % 5 === 0) {
      const minuteBucket = now.toISOString().slice(0, 16);
      await fireOnce(`capsule_${minuteBucket}`, () => checkCapsuleUnlocks(dbOps, pushFn));
    }
  }, 60 * 1000);
}

async function broadcastPush(dbOps: DbOps, pushFn: SendPushFn, type: string): Promise<void> {
  // Fan out per user (not per token) so pushToUser can populate the APNs
  // badge with each recipient's real unread total. Going through the raw
  // pushFn here would bypass that and leave the icon badge unchanged —
  // which is exactly the bug fixed by routing all pushes through
  // pushToUser. Concurrent dispatch is preserved: @parse/node-apn uses
  // HTTP/2 multiplexing so many pushes share one connection, and a single
  // slow/dead token can't stall the rest within Promise.allSettled.
  const userIds = dbOps.getAllPairedUserIds();
  await Promise.allSettled(
    userIds.map((userId) => pushToUser(dbOps, pushFn, userId, type, ''))
  );
}

async function checkCapsuleUnlocks(dbOps: DbOps, pushFn: SendPushFn): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  // `getUnlockableCapsules` now filters `notified_at IS NULL` server-side,
  // so each capsule appears here exactly once across the lifetime of the
  // process — no more 5-min cutoff filter needed, and no duplicate pushes
  // across pm2 restarts.
  const capsules = dbOps.getUnlockableCapsules(nowIso);
  if (capsules.length === 0) return;

  // Mark notified BEFORE pushing. If the push then fails (network, APNs
  // outage), we miss ONE push for that capsule — preferable to retrying
  // every 5min forever and spamming the recipient if their token is dead.
  dbOps.markCapsulesNotified(capsules.map(c => c.id), nowIso);

  const notified = new Set<string>();

  for (const capsule of capsules) {
    // Notify only the RECIPIENT of the capsule:
    //   self-vis  → author (it's a letter to their future self)
    //   partner-vis → partner (the author already knows they sent it; the
    //                 inbox view also filters their own outgoing partner-vis
    //                 capsules out, so a "your capsule unlocked" push to the
    //                 author would land on an empty inbox)
    const recipientId = capsule.visibility === 'self' ? capsule.user_id : capsule.partner_id;
    if (notified.has(recipientId)) continue;
    notified.add(recipientId);
    await pushToUser(dbOps, pushFn, recipientId, 'capsule_unlock', '');
  }
}
