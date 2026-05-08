// Runtime verification for the client-side bug fixes that don't need a
// React Native test harness. Each block models the production logic
// from the cited source file (no RN deps in those, so the model and the
// real code are 1:1). Run with: `node scripts/verify-client-fixes.mjs`.
//
// What this proves:
//   - Bug 5 (IslandToast FIFO queue): a burst of 5 show() calls
//     plays all 5 in order, instead of the old "latest wins" collapse.
//   - Bug 6 (getDeviceTimezone cache): repeated calls hit the Intl
//     lookup once per session; refreshDeviceTimezoneCache() resets
//     the cache so the next call re-reads the OS timezone.
//
// The script re-implements the logic verbatim from the source — see
// the citations at the top of each block. If the production file
// diverges from this model, this script no longer represents reality;
// keep them in sync.

import assert from 'node:assert/strict';

let failed = 0;

// ─────────────────────────────────────────────────────────────────────
// Bug 6 — src/utils/timezone.ts
// ─────────────────────────────────────────────────────────────────────
console.log('--- Bug 6: getDeviceTimezone cache ---');
try {
  let cached = null;
  function getDeviceTimezone() {
    if (cached) return cached;
    try {
      cached = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      cached = 'Asia/Shanghai';
    }
    return cached;
  }
  function refreshDeviceTimezoneCache() {
    cached = null;
  }

  // Wrap Intl.DateTimeFormat so we can count constructor calls.
  let intlCalls = 0;
  const Original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function (...args) {
    intlCalls++;
    return new Original(...args);
  };
  // Keep static members (e.g. supportedLocalesOf) reachable.
  Object.setPrototypeOf(Intl.DateTimeFormat, Original);

  const tz1 = getDeviceTimezone();
  assert.equal(intlCalls, 1, '1st call should hit Intl exactly once');
  const tz2 = getDeviceTimezone();
  assert.equal(intlCalls, 1, '2nd call should be served from cache');
  assert.equal(tz1, tz2, 'cached value should match');
  refreshDeviceTimezoneCache();
  const tz3 = getDeviceTimezone();
  assert.equal(intlCalls, 2, 'after refresh, next call should hit Intl');
  assert.equal(tz3, tz1, 'value should still be the same OS tz');

  Intl.DateTimeFormat = Original;
  console.log(`  ✓ 1st call hits Intl, count=${1}`);
  console.log(`  ✓ 2nd call cached, count still 1`);
  console.log(`  ✓ refresh invalidates: next call count=2`);
} catch (e) {
  failed++;
  console.error('  ✗ FAILED:', e.message);
}

// ─────────────────────────────────────────────────────────────────────
// Bug 5 — src/components/IslandToast.tsx (queue + playNext + show)
// ─────────────────────────────────────────────────────────────────────
console.log('\n--- Bug 5: IslandToast FIFO queue ---');
try {
  // Re-implementation. animateIn / animateOut are abstracted to "tick"
  // events so we can verify play order without a timeline.
  const queue = [];
  let playing = false;
  const order = [];

  function playNext() {
    const next = queue.shift();
    if (!next) {
      playing = false;
      return;
    }
    playing = true;
    order.push(next.msg);
    // Models animateOut → setMessage(null) → cb (= playNext) on next
    // microtask. setImmediate keeps the FIFO property the same way the
    // RN timeline does, without coupling to real durations.
    setImmediate(playNext);
  }
  function show(msg) {
    queue.push({ msg });
    if (!playing) playNext();
  }

  // Burst 5 calls in a tight loop — old code would have only displayed
  // the 5th; new code plays all 5 sequentially.
  show('first');
  show('second');
  show('third');
  show('fourth');
  show('fifth');

  // Drain pending microtasks.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
  }

  assert.deepEqual(
    order,
    ['first', 'second', 'third', 'fourth', 'fifth'],
    'all 5 should play in FIFO order',
  );
  assert.equal(playing, false, 'playing flag should release after drain');
  console.log(`  ✓ 5 toasts in burst → all 5 displayed in order`);
  console.log(`  ✓ playing flag releases when queue drains`);

  // hide() drops the queue mid-flight — next show should still kick off.
  function hide() {
    queue.length = 0;
    playing = false;
  }
  show('a');
  show('b');
  show('c');
  hide();
  show('after-hide');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(
    order[order.length - 1],
    'after-hide',
    'after hide(), the next show should still play',
  );
  console.log(`  ✓ hide() drops queue but next show resumes cleanly`);
} catch (e) {
  failed++;
  console.error('  ✗ FAILED:', e.message);
}

// ─────────────────────────────────────────────────────────────────────
console.log('');
if (failed === 0) {
  console.log(`✅ All ${2} client-logic checks passed`);
  process.exit(0);
} else {
  console.error(`❌ ${failed} check(s) failed`);
  process.exit(1);
}
