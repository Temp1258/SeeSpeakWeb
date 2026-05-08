// Shared device-timezone helper. Used to live as a private function in
// both api.ts and HistoryScreen.tsx — both copies called
// Intl.DateTimeFormat().resolvedOptions() on every invocation, which on
// every API request adds up to thousands of redundant Intl lookups over
// a session. Now cached once per session, invalidated when the OS
// foreground transition fires (App.tsx wires that) so a user changing
// the device timezone in Settings still picks up the new value.

let cached: string | null = null;

export function getDeviceTimezone(): string {
  if (cached) return cached;
  try {
    cached = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    cached = 'Asia/Shanghai';
  }
  return cached;
}

export function refreshDeviceTimezoneCache(): void {
  cached = null;
}
