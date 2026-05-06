import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import crypto from 'crypto';
import { DbOps } from './db';
import { pushToUser, type SendPushFn } from './push';

interface Ticket {
  userId: string;
  expiresAt: number;
}

interface CouplePresence {
  // userId -> set of currently-connected socket ids. A user may have several
  // devices online at once (phone + iPad). The userId entry is removed
  // entirely when the set goes empty, so `sockets.size` always equals the
  // number of distinct users with at least one live socket (0, 1, or 2).
  sockets: Map<string, Set<string>>;
  bothOnlineTimer?: ReturnType<typeof setTimeout>;
  bothEmitted: boolean;
  userIds: [string, string];
  // Pat unread counter, keyed by RECIPIENT user id. Resets when the recipient
  // reconnects (i.e. they came back online — implicit "I've seen them").
  // Lets a 拍拍 push body show "想你了 N 下" rolling tally.
  patUnread: Map<string, number>;
}

const tickets = new Map<string, Ticket>();
const presenceMap = new Map<string, CouplePresence>();
// Captured at setupSocket time so other modules (e.g. routes.ts) can broadcast
// to a couple's room without a circular import or full DI plumbing.
let ioRef: Server | null = null;

// Broadcast an event into the room shared by `userIdA` and `userIdB`. Both
// sides receive it — recipients should filter via the `from` field in the
// payload to avoid haptic-feedback'ing the sender.
export function emitToCouple(
  userIdA: string,
  userIdB: string,
  event: string,
  data?: Record<string, unknown>,
): void {
  if (!ioRef) return;
  ioRef.to(coupleKey(userIdA, userIdB)).emit(event, data ?? {});
}

// True iff the user has at least one live socket connection. Used by REST
// handlers to suppress push notifications for events the recipient will
// receive in real time via the socket — avoids redundant banners/badges
// while the app is foregrounded.
export function isUserOnline(userId: string): boolean {
  for (const presence of presenceMap.values()) {
    const set = presence.sockets.get(userId);
    if (set && set.size > 0) return true;
  }
  return false;
}

// Forcibly tear down every live socket for a couple. Called from /unpair
// so neither side can keep receiving the partner's `touch_start`,
// `sticky_update`, etc. via an already-established connection — without
// this, the room stays joined until each client naturally drops or
// restarts. Also evicts the in-memory presence row + pat tally.
export function disconnectCouple(userIdA: string, userIdB: string): void {
  if (!ioRef) return;
  const key = coupleKey(userIdA, userIdB);
  const presence = presenceMap.get(key);
  if (!presence) return;
  for (const set of presence.sockets.values()) {
    for (const sid of set) {
      const socket = ioRef.sockets.sockets.get(sid);
      if (socket) socket.disconnect(true);
    }
  }
  if (presence.bothOnlineTimer) {
    clearTimeout(presence.bothOnlineTimer);
  }
  presenceMap.delete(key);
}

function coupleKey(a: string, b: string): string {
  return [a, b].sort().join(':');
}

export function createWsTicket(userId: string): string {
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, { userId, expiresAt: Date.now() + 30000 });
  return ticket;
}

export function setupSocket(httpServer: HttpServer, dbOps: DbOps, pushFn?: SendPushFn): Server {
  const io = new Server(httpServer, {
    // Defense-in-depth: ticket auth is the primary guard, but pinning origin
    // means a malicious browser tab can't even open the socket. RN App has
    // no Origin header so it's unaffected.
    cors: {
      origin: ['https://couple-buzz.com', 'https://api.couple-buzz.com:8443'],
      credentials: false,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 30000,
    pingInterval: 15000,
  });
  ioRef = io;

  // Auth middleware: validate ticket
  io.use((socket, next) => {
    const ticket = socket.handshake.auth?.ticket as string;
    if (!ticket) return next(new Error('missing_ticket'));

    const stored = tickets.get(ticket);
    if (!stored || stored.expiresAt < Date.now()) {
      tickets.delete(ticket);
      return next(new Error('invalid_ticket'));
    }

    tickets.delete(ticket);
    socket.data.userId = stored.userId;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;
    const user = dbOps.getUser(userId);
    if (!user?.partner_id) {
      socket.disconnect();
      return;
    }

    const partnerId = user.partner_id;
    const key = coupleKey(userId, partnerId);

    // Rolling-window rate limit on this socket's `touch_start` emits — at
    // most 5 events per 1s window. Holding a finger down only fires ONE
    // touch_start (until release+re-press), so legit hold-to-touch is
    // unaffected. Caps DoS via amplified APNs pushes when a buggy or
    // malicious client emits faster than humanly possible.
    const TOUCH_MAX = 5;
    const TOUCH_WINDOW_MS = 1000;
    let touchTimestamps: number[] = [];

    if (!presenceMap.has(key)) {
      presenceMap.set(key, {
        sockets: new Map(),
        bothEmitted: false,
        userIds: [userId, partnerId],
        patUnread: new Map(),
      });
    }
    const presence = presenceMap.get(key)!;
    // Add this socket to the user's set. Multiple devices for the same user
    // accumulate here, so a single device disconnecting later does not
    // prematurely flip the user to offline.
    let mySet = presence.sockets.get(userId);
    if (!mySet) {
      mySet = new Set();
      presence.sockets.set(userId, mySet);
    }
    mySet.add(socket.id);
    // This user is back online — they're seeing the partner directly, so any
    // pending pat tally for them resets to zero.
    presence.patUnread.set(userId, 0);

    socket.join(key);
    checkBothOnline(io, key, presence);
    socket.to(key).emit('partner_online', { online: true });

    // Check if partner is in the same room and currently touching. Scan all
    // of partner's sockets, since any one of their devices could be the
    // touching device.
    const partnerSet = presence.sockets.get(partnerId);
    if (partnerSet && partnerSet.size > 0) {
      // Tell the new user that partner is online
      socket.emit('partner_online', { online: true });
      for (const partnerSocketId of partnerSet) {
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        if (partnerSocket?.data.isTouching) {
          socket.emit('touch_start', { from: partnerId });
          break;
        }
      }
    } else {
      // Partner is offline — push an authoritative "alone" snapshot to this
      // socket. Without it, a stale `presence_both` from a prior session
      // (e.g. user backgrounded the app while both were online, then
      // reconnects after partner has gone offline) would keep the
      // "同时想着对方" badge lit forever, since presence_single was only
      // ever sent to the *other* side at the moment of disconnect.
      socket.emit('presence_single');
    }

    // Touch relay
    socket.data.isTouching = false;

    socket.on('touch_start', () => {
      // Drop entries older than the window, then check if we're at cap.
      const now = Date.now();
      touchTimestamps = touchTimestamps.filter(t => now - t < TOUCH_WINDOW_MS);
      if (touchTimestamps.length >= TOUCH_MAX) {
        return; // silently drop — protects partner-side battery + APNs cost
      }
      touchTimestamps.push(now);

      socket.data.isTouching = true;
      socket.to(key).emit('touch_start', { from: userId });

      // Push only when partner is offline (otherwise they see the touch in
      // real time on Home). Every pat fires a push — APNs collapses them into
      // a single rolling notification on the lock screen via collapseId, so
      // the partner doesn't get N stacked alerts. Body shows the tally.
      const partnerConnected = (presence.sockets.get(partnerId)?.size ?? 0) > 0;
      if (!partnerConnected && pushFn) {
        const tally = (presence.patUnread.get(partnerId) ?? 0) + 1;
        presence.patUnread.set(partnerId, tally);
        // Badge: emoji unread + 1 (representing "an unread pat series").
        // Multiple pats in the series keep emoji_unread the same → badge
        // stays put, matching the user's "+1 only" expectation.
        const emojiUnread = dbOps.getUnreadActionCount(partnerId, userId);
        const badge = emojiUnread + 1;
        const body = `${user.name} 想你了 ${tally} 下！🥹`;
        const collapseId = `pat_${userId}`;
        // Fire-and-forget — touch_start handler must return synchronously
        // for the rate-limit window math; awaiting would gate every pat
        // on APNs RTT and starve the WebSocket emit downstream.
        void pushToUser(dbOps, pushFn, partnerId, 'touch', user.name, undefined, badge, collapseId, body);
      }
    });

    socket.on('touch_end', () => {
      socket.data.isTouching = false;
      socket.to(key).emit('touch_end', { from: userId });
    });

    socket.on('disconnect', () => {
      const set = presence.sockets.get(userId);

      if (socket.data.isTouching) {
        // Only forward touch_end if NO other device of this same user is
        // still touching. Otherwise a partner who is using both phone and
        // iPad to touch would see the receive-state cancel as soon as one
        // device drops, even though they're still touching from the other.
        let anyOtherTouching = false;
        if (set) {
          for (const otherId of set) {
            if (otherId === socket.id) continue;
            const other = io.sockets.sockets.get(otherId);
            if (other?.data.isTouching) {
              anyOtherTouching = true;
              break;
            }
          }
        }
        if (!anyOtherTouching) {
          socket.to(key).emit('touch_end', { from: userId });
        }
      }

      // Remove THIS socket from the user's set. If it's the user's last
      // device, remove the userId entry entirely so `sockets.size` reflects
      // the count of online users (not online sockets).
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          presence.sockets.delete(userId);
        }
      }

      // Gate offline-side-effects on whether the user actually has zero
      // remaining sockets. The Set + size==0 cleanup above makes
      // `presence.sockets.has(userId)` the right signal.
      //
      // Cancel the both-online timer immediately (it was about TO emit
      // both-online; we no longer want that). The OFFLINE emits, however,
      // are deferred — a quick reconnect (AppState foreground / wifi
      // hiccup) typically re-registers within ~1s. Without the defer the
      // partner sees a "对方掉线 → 对方在线" flicker. Symmetric to the
      // 1.0.2 "presence_single 残留" fix.
      if (!presence.sockets.has(userId) && presence.bothOnlineTimer) {
        clearTimeout(presence.bothOnlineTimer);
        presence.bothOnlineTimer = undefined;
      }

      const RECONNECT_GRACE_MS = 1500;
      setTimeout(() => {
        // If the map slot has been replaced (e.g. both users went offline →
        // map deleted → someone reconnected → fresh presence created), the
        // new connection handler is already authoritative. Our closure's
        // `presence` is now stale; bail before emitting anything to the
        // room or the new session would get a phantom "对方掉线" signal.
        if (presenceMap.get(key) !== presence) return;
        // Re-check user's online state after the grace window — they may
        // have reconnected and re-registered into THIS same presence.
        if (presence.sockets.has(userId)) return;
        socket.to(key).emit('partner_online', { online: false });
        if (presence.bothEmitted) {
          io.to(key).emit('presence_single');
          presence.bothEmitted = false;
        }
        if (presence.sockets.size === 0) {
          presenceMap.delete(key);
        }
      }, RECONNECT_GRACE_MS);
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of tickets) {
      if (v.expiresAt < now) tickets.delete(k);
    }
  }, 60000);

  return io;
}

function checkBothOnline(io: Server, key: string, presence: CouplePresence) {
  if (presence.sockets.size >= 2) {
    if (presence.bothOnlineTimer) clearTimeout(presence.bothOnlineTimer);
    presence.bothOnlineTimer = setTimeout(() => {
      if (presence.sockets.size >= 2) {
        io.to(key).emit('presence_both');
        presence.bothEmitted = true;
      }
    }, 3000);
  }
}
