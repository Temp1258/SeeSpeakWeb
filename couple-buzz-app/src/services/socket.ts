import { io, Socket } from 'socket.io-client';
import { API_URL } from '../constants';
import { api } from './api';

let socket: Socket | null = null;
let connecting = false;
let ticketRetries = 0;
const MAX_TICKET_RETRIES = 3;

type Listener = (...args: any[]) => void;
const listeners: Record<string, Set<Listener>> = {};

function emit(event: string, ...args: any[]) {
  listeners[event]?.forEach(fn => fn(...args));
}

export function subscribe(event: string, fn: Listener): () => void {
  if (!listeners[event]) listeners[event] = new Set();
  listeners[event].add(fn);
  return () => { listeners[event]?.delete(fn); };
}

export async function connectSocket(): Promise<void> {
  if (socket?.connected || connecting) return;
  connecting = true;
  // Reset retry counter for this fresh attempt — important when a previous
  // attempt exhausted retries (e.g. session was revoked) and the user has
  // since re-logged-in / re-paired.
  ticketRetries = 0;

  try {
    const { ticket } = await api.getWsTicket();

    // Clean up old socket if exists
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }

    socket = io(API_URL, {
      auth: { ticket },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: Infinity,
    });

    socket.on('touch_start', (data) => emit('touch_start', data));
    socket.on('touch_end', (data) => emit('touch_end', data));
    socket.on('partner_online', (data) => emit('partner_online', data));
    socket.on('presence_both', () => emit('presence_both'));
    socket.on('presence_single', () => emit('presence_single'));
    socket.on('action_new', (data) => emit('action_new', data));
    socket.on('sticky_update', (data) => emit('sticky_update', data));

    socket.on('connect', () => {
      ticketRetries = 0;
    });

    socket.on('connect_error', async (err) => {
      // Capture the socket instance this handler belongs to. After the
      // `await api.getWsTicket()` below, the module-level `socket` may have
      // been swapped (e.g. AppState background → disconnectSocket() →
      // foreground → fresh connectSocket() created a new instance during
      // our await). Without this guard we'd feed THIS handler's new ticket
      // to the unrelated new socket, which then connects with the wrong
      // ticket and races the new connectSocket's own ticket fetch.
      const myInstance = socket;
      if (err.message === 'invalid_ticket' || err.message === 'missing_ticket') {
        if (ticketRetries >= MAX_TICKET_RETRIES) {
          // Session is genuinely gone (server-side token revoked / unpair).
          // Stop the underlying socket.io reconnection loop — without this
          // it would keep reconnecting forever with the now-bad ticket,
          // burning battery + bandwidth in the background. The next
          // explicit connectSocket() call (post re-login / app foreground)
          // will start fresh with the retry counter reset.
          if (myInstance && socket === myInstance) {
            socket.disconnect();
            socket = null;
          }
          return;
        }
        ticketRetries++;
        try {
          const { ticket: newTicket } = await api.getWsTicket();
          // After the await, only mutate if the active socket is still
          // the one this handler was attached to — otherwise we'd corrupt
          // a fresh connectSocket()'s in-flight handshake.
          if (myInstance && socket === myInstance) {
            myInstance.auth = { ticket: newTicket };
            myInstance.connect();
          }
        } catch {
          // getWsTicket itself failed (e.g. session-level 401). The next
          // reconnect attempt will land here again and eventually exhaust
          // ticketRetries → trigger the disconnect path above.
        }
      }
    });
  } catch {}

  connecting = false;
}

export function disconnectSocket(): void {
  connecting = false;
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

export function emitTouchStart(): void {
  socket?.emit('touch_start');
}

export function emitTouchEnd(): void {
  socket?.emit('touch_end');
}

export function isConnected(): boolean {
  return socket?.connected ?? false;
}
