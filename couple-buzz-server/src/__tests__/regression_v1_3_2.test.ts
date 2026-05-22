/**
 * Regression tests for v1.3.2:
 *
 *   #1 — 废话区 pagination loads ONE batch per drag interaction (instead
 *        of cascading from the user's scroll-top all the way back to
 *        message #1). Implemented as an interaction state machine
 *        (idle → dragging → momentum → idle) plus a per-interaction
 *        "fired once" latch in HistoryScreen.tsx.
 *
 *   #2 — SnapCalendarScreen gains a ta｜我 segmented toggle at the
 *        bottom-right. Cells render only the selected side's photo,
 *        the preview overlay respects the same mode, the polaroid
 *        accent stripe colour follows the mode (pink for me, blue
 *        for ta), and anti-peek is still enforced server-side
 *        (partner_photo=null when the caller hasn't snapped that day).
 */

import fs from 'fs';
import path from 'path';

// ────────────────────────────────────────────────────────────────────
// #1 — HistoryScreen: drag-gated pagination
// ────────────────────────────────────────────────────────────────────

describe('#1 — HistoryScreen pagination fires once per user-driven scroll', () => {
  const HIST_SRC = fs.readFileSync(
    path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'couple-buzz-app',
      'src',
      'screens',
      'HistoryScreen.tsx',
    ),
    'utf8',
  );

  it('tracks scroll interaction state via a ref', () => {
    expect(HIST_SRC).toMatch(/interactionRef\s*=\s*useRef<\s*'idle'\s*\|\s*'dragging'\s*\|\s*'momentum'\s*>/);
  });

  it('latches "fired once" per interaction via firedThisInteractionRef', () => {
    expect(HIST_SRC).toMatch(/firedThisInteractionRef\s*=\s*useRef\(false\)/);
  });

  it('onScrollBeginDrag flips the state to dragging AND clears the fired latch', () => {
    // Both side-effects MUST happen on drag begin, otherwise the user
    // can't load a second page even with another drag.
    expect(HIST_SRC).toMatch(
      /onScrollBeginDrag\s*=\s*useCallback\(\(\)\s*=>\s*\{[\s\S]*?interactionRef\.current\s*=\s*'dragging'[\s\S]*?firedThisInteractionRef\.current\s*=\s*false[\s\S]*?\}/,
    );
  });

  it('onScrollEndDrag inspects velocity — zero ⇒ idle, non-zero ⇒ momentum', () => {
    expect(HIST_SRC).toMatch(
      /onScrollEndDrag\s*=\s*useCallback\([\s\S]*?velocity[\s\S]*?Math\.abs\(vy\)\s*<\s*0\.01[\s\S]*?'idle'[\s\S]*?'momentum'/,
    );
  });

  it('onMomentumScrollEnd resets the state to idle so the next drag is a fresh interaction', () => {
    expect(HIST_SRC).toMatch(
      /onMomentumScrollEnd\s*=\s*useCallback\(\(\)\s*=>\s*\{[\s\S]*?interactionRef\.current\s*=\s*'idle'/,
    );
  });

  it('onListScroll gates loadOlder on interactionRef !== "idle" AND !firedThisInteractionRef', () => {
    // Both guards must be checked BEFORE setting firedThisInteractionRef = true.
    // Otherwise we either re-fire mid-momentum or fire on a non-user scroll.
    expect(HIST_SRC).toMatch(
      /interactionRef\.current\s*!==\s*'idle'[\s\S]*?!firedThisInteractionRef\.current[\s\S]*?firedThisInteractionRef\.current\s*=\s*true[\s\S]*?loadOlder\(\)/,
    );
  });

  it('SectionList wires all four interaction handlers (begin/end drag + momentum begin/end)', () => {
    expect(HIST_SRC).toMatch(/onScrollBeginDrag=\{onScrollBeginDrag\}/);
    expect(HIST_SRC).toMatch(/onScrollEndDrag=\{onScrollEndDrag\}/);
    expect(HIST_SRC).toMatch(/onMomentumScrollBegin=\{onMomentumScrollBegin\}/);
    expect(HIST_SRC).toMatch(/onMomentumScrollEnd=\{onMomentumScrollEnd\}/);
  });

  it('keeps the maintainVisibleContentPosition + loadOlder + hasMore + 80pt-trigger machinery from v1.3.1', () => {
    // The v1.3.2 fix layers ON TOP of v1.3.1's pagination; it does not
    // remove the prior plumbing. Sanity-check the load fence is still in place.
    expect(HIST_SRC).toMatch(/maintainVisibleContentPosition=\{\{[^}]*minIndexForVisible/);
    expect(HIST_SRC).toMatch(/contentOffset\.y\s*<\s*80/);
    expect(HIST_SRC).toMatch(/api\.getHistory\(50,\s*earliestIdRef\.current\)/);
  });
});

// ────────────────────────────────────────────────────────────────────
// #2 — SnapCalendarScreen: ta｜我 toggle
// ────────────────────────────────────────────────────────────────────

describe('#2 — SnapCalendarScreen has a bottom-right ta｜我 segmented toggle', () => {
  const SC_SRC = fs.readFileSync(
    path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'couple-buzz-app',
      'src',
      'screens',
      'SnapCalendarScreen.tsx',
    ),
    'utf8',
  );

  it("declares viewMode state typed 'ta' | 'me' with default 'me'", () => {
    // Default 'me' is deliberate — personal photos first matches the
    // user-mental-model ergonomics ("show me what I shot, then I can
    // peek at ta's").
    expect(SC_SRC).toMatch(/useState<\s*'ta'\s*\|\s*'me'\s*>\('me'\)/);
  });

  it('uses an Animated.Value + interpolate(translateX) for the indicator slide', () => {
    expect(SC_SRC).toMatch(/indicatorAnim\s*=\s*useRef\(\s*new\s+Animated\.Value/);
    expect(SC_SRC).toMatch(/indicatorAnim\.interpolate\(\{[\s\S]*?inputRange:\s*\[0,\s*1\]/);
    expect(SC_SRC).toMatch(/translateX:\s*indicatorAnim\.interpolate/);
  });

  it('runs the indicator slide on the native driver for smoothness', () => {
    expect(SC_SRC).toMatch(/Animated\.spring\(indicatorAnim[\s\S]*?useNativeDriver:\s*true/);
  });

  it('cells render visiblePhoto picked by viewMode (me ⇒ my_photo, ta ⇒ partner_photo)', () => {
    expect(SC_SRC).toMatch(
      /viewMode\s*===\s*'me'\s*\?\s*snap\?\.\s*my_photo\s*:\s*snap\?\.\s*partner_photo/,
    );
  });

  it('cell onPress is gated on hasVisible (cells with no photo for the current mode are inert)', () => {
    expect(SC_SRC).toMatch(/onPress=\{\(\)\s*=>\s*hasVisible\s*&&\s*snap\s*&&\s*onCellTap\(snap\)\}/);
  });

  it('PolaroidThumb renders a single image + an accent stripe (single-photo layout, not the old composite)', () => {
    expect(SC_SRC).toMatch(/function\s+PolaroidThumb\(\{[\s\S]*?photoUri[\s\S]*?dayLabel[\s\S]*?accent[\s\S]*?\}/);
    expect(SC_SRC).toMatch(/<View\s+style=\{\[polaroidStyles\.accentStripe,\s*\{\s*backgroundColor:\s*accent\s*\}\]\}/);
  });

  it('accent colour follows viewMode (pink COLORS.kiss for me, partner accent for ta)', () => {
    expect(SC_SRC).toMatch(/accent=\{viewMode\s*===\s*'me'\s*\?\s*COLORS\.kiss\s*:\s*PARTNER_ACCENT\}/);
    // The partner accent is a defined constant (not hard-coded in JSX),
    // so the colour change tracks one source of truth.
    expect(SC_SRC).toMatch(/const\s+PARTNER_ACCENT\s*=\s*'#[0-9A-Fa-f]{6}'/);
  });

  it('the preview overlay also respects viewMode — only the matching side renders', () => {
    expect(SC_SRC).toMatch(
      /function\s+SnapPreviewOverlay\(\{[\s\S]*?viewMode[\s\S]*?\}: \{[\s\S]*?viewMode:\s*'ta'\s*\|\s*'me'/,
    );
    // Mode → which path to render. Anti-peek (partner_photo=null when
    // I haven't snapped) is still preserved by the early-out below.
    expect(SC_SRC).toMatch(/path\s*=\s*viewMode\s*===\s*'me'\s*\?\s*snap\.my_photo\s*:\s*snap\.partner_photo/);
    expect(SC_SRC).toMatch(/if\s*\(!path\)\s*return\s+null/);
  });

  it('preview overlay is rendered with snap + viewMode props from the parent', () => {
    expect(SC_SRC).toMatch(
      /<SnapPreviewOverlay[\s\S]*?snap=\{expanded\}[\s\S]*?viewMode=\{viewMode\}/,
    );
  });

  it('toggle UI floats at the bottom-right (insets.bottom + 16, right: 20)', () => {
    // Same vertical row as the 收起 pill; right-anchored.
    expect(SC_SRC).toMatch(/toggleSlot:\s*\{[\s\S]*?position:\s*'absolute'[\s\S]*?right:\s*20/);
    expect(SC_SRC).toMatch(/styles\.toggleSlot,\s*\{\s*bottom:\s*insets\.bottom\s*\+\s*16\s*\}/);
  });

  it('both segment buttons fire selection haptics on tap', () => {
    // Two distinct selectionAsync() calls — one per segment.
    const haptics = SC_SRC.match(/Haptics\.selectionAsync\(\)/g) || [];
    expect(haptics.length).toBeGreaterThanOrEqual(4); // 2 toggle + 2 month arrows
    // And both setViewMode targets are present.
    expect(SC_SRC).toMatch(/setViewMode\('ta'\)/);
    expect(SC_SRC).toMatch(/setViewMode\('me'\)/);
  });

  it('active segment text uses toggleTextActive styling (white-on-pink contrast)', () => {
    expect(SC_SRC).toMatch(
      /\[styles\.toggleText,\s*viewMode\s*===\s*'ta'\s*&&\s*styles\.toggleTextActive\]/,
    );
    expect(SC_SRC).toMatch(
      /\[styles\.toggleText,\s*viewMode\s*===\s*'me'\s*&&\s*styles\.toggleTextActive\]/,
    );
  });

  it('drops the old two-photo composite styles (partner / mine / mineOverlap) — single-photo layout only', () => {
    // If any of these survived, the layout would render two stacked
    // photos instead of one, defeating the toggle.
    expect(SC_SRC).not.toMatch(/polaroidStyles\.partner\b/);
    expect(SC_SRC).not.toMatch(/polaroidStyles\.mine\b/);
    expect(SC_SRC).not.toMatch(/polaroidStyles\.mineOverlap\b/);
  });
});
