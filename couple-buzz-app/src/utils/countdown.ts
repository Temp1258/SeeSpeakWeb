import { useEffect, useState } from 'react';

const BJT_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 86400000;

export interface Countdown {
  hh: string;
  mm: string;
  ss: string;
  totalSec: number;
  done: boolean;
}

function compute(targetMs: number, nowMs: number): Countdown {
  const left = Math.max(0, targetMs - nowMs);
  const totalSec = Math.floor(left / 1000);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return {
    hh: String(hh).padStart(2, '0'),
    mm: String(mm).padStart(2, '0'),
    ss: String(ss).padStart(2, '0'),
    totalSec,
    done: totalSec === 0,
  };
}

// Counts down to a UTC timestamp, ticking once per second.
// Pass null when the target isn't ready; returned countdown is zeroed.
export function useCountdown(target: Date | string | null): Countdown {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!target) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);

  if (!target) return compute(0, now);
  const targetMs = typeof target === 'string' ? Date.parse(target) : target.getTime();
  return compute(targetMs, now);
}

// Counts down to the next 7am Beijing time (UTC+8), auto-rolling each day.
// BJT 7am corresponds to UTC 23:00 of the prior day, i.e. midnight in a UTC+1
// frame — so we anchor on a +1h shift and find the next midnight there.
const BJT_7AM_SHIFT_MS = (BJT_OFFSET_MS - 7 * 3600 * 1000); // = +1h
export function useBeijing7amCountdown(): Countdown {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const shifted = now + BJT_7AM_SHIFT_MS;
  let nextMid = Math.ceil(shifted / DAY_MS) * DAY_MS;
  if (nextMid === shifted) nextMid += DAY_MS;
  return compute(nextMid - BJT_7AM_SHIFT_MS, now);
}

// Absolute UTC ms of the next 7am Beijing time (= next daily-question /
// snap refresh boundary). Re-evaluated each minute so it rolls forward
// across the boundary without needing per-second ticks.
export function useNextDailyRefreshAt(): number {
  const [tickMs, setTickMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTickMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const shifted = tickMs + BJT_7AM_SHIFT_MS;
  let nextMid = Math.ceil(shifted / DAY_MS) * DAY_MS;
  if (nextMid <= shifted) nextMid += DAY_MS;
  return nextMid - BJT_7AM_SHIFT_MS;
}

// Absolute UTC ms of the next 半日达 reveal — server reveals at UTC 0:00
// and 12:00 daily (= 8am / 8pm BJT), one boundary every 12h. A letter
// written *now* will be delivered at the next such boundary; this hook
// gives the floating "下个半日达将于 ... 寄达" hint a real wall-clock
// target rendered in the user's tz. Same minute-tick cadence as
// useNextDailyRefreshAt — the boundary moves at most once an hour, so
// per-second ticks would be wasted re-renders.
const HALF_DAY_MS = 12 * 3600 * 1000;
export function useNextHalfDayRevealAt(): number {
  const [tickMs, setTickMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTickMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  let next = Math.ceil(tickMs / HALF_DAY_MS) * HALF_DAY_MS;
  if (next <= tickMs) next += HALF_DAY_MS;
  return next;
}
