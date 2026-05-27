/**
 * Regression tests for v1.3.4:
 *
 *   #1 — Letter reader gains scroll affordances. v1.3.3 fixed the
 *        layout (long letters CAN scroll), but users still didn't
 *        realize they could — no visual cue that more content sits
 *        below. v1.3.4 layers three discoverability fixes on top:
 *
 *        a) showsVerticalScrollIndicator turned back on (was forced
 *           off). iOS shows the indicator briefly during touch +
 *           after a flick — subtle but enough to register "yes, this
 *           scrolls".
 *        b) "More below" gradient overlay at the bottom of the
 *           ScrollView. Rendered only when content overflows;
 *           opacity fades to 0 as the user approaches the bottom.
 *           pointerEvents="none" so it never intercepts drags.
 *        c) tapHint copy now reads "拖动阅读 · 轻点空白处收起" —
 *           the drag affordance is also stated explicitly.
 *
 *        Plus a reset useEffect so that re-opening a different
 *        letter starts at scroll-top with cleared measurements.
 */

import fs from 'fs';
import path from 'path';

describe('#1 — letter reader exposes scroll affordances', () => {
  const ENV_SRC = fs.readFileSync(
    path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'couple-buzz-app',
      'src',
      'components',
      'EnvelopeOpenAnimation.tsx',
    ),
    'utf8',
  );

  it('shows the vertical scroll indicator (turned back on; was forced false)', () => {
    expect(ENV_SRC).toMatch(/showsVerticalScrollIndicator=\{true\}/);
    expect(ENV_SRC).not.toMatch(/showsVerticalScrollIndicator=\{false\}/);
  });

  it('imports LinearGradient for the "more below" fade overlay', () => {
    expect(ENV_SRC).toMatch(
      /import\s+\{\s*LinearGradient\s*\}\s+from\s+'expo-linear-gradient'/,
    );
  });

  it('wraps the ScrollView in a contentWrap View so the overlay can anchor to the scroll-area bottom', () => {
    expect(ENV_SRC).toMatch(/contentWrap:/);
    expect(ENV_SRC).toMatch(/<View\s+style=\{styles\.contentWrap\}>/);
  });

  it('defines a bottomFade style anchored absolute to bottom: 0', () => {
    expect(ENV_SRC).toMatch(
      /bottomFade:\s*\{[\s\S]*?position:\s*'absolute'[\s\S]*?bottom:\s*0[\s\S]*?\}/,
    );
  });

  it('the bottomFade is gated on hasOverflow (no overlay for short letters that already fit)', () => {
    expect(ENV_SRC).toMatch(
      /hasOverflow[\s\S]*?<Animated\.View[\s\S]*?styles\.bottomFade/,
    );
  });

  it('the bottomFade has pointerEvents="none" so it does not steal ScrollView drag gestures', () => {
    expect(ENV_SRC).toMatch(/styles\.bottomFade[\s\S]*?pointerEvents="none"/);
  });

  it('LinearGradient fades from transparent to the letter card colour (COLORS.white)', () => {
    expect(ENV_SRC).toMatch(
      /<LinearGradient[\s\S]*?colors=\{\['rgba\(255,255,255,0\)',\s*COLORS\.white\]\}/,
    );
  });

  it('uses Animated.event on onScroll so the fade opacity tracks scroll position without re-rendering', () => {
    expect(ENV_SRC).toMatch(
      /Animated\.event\([\s\S]*?contentOffset:\s*\{\s*y:\s*scrollY\s*\}/,
    );
    // Plain ScrollView is preserved (JS-driven Animated.event), so the
    // v1.3.3 maxHeight on contentScroll still works the same way.
    expect(ENV_SRC).toMatch(/useNativeDriver:\s*false/);
  });

  it('tracks both content height (onContentSizeChange) and visible height (onLayout)', () => {
    expect(ENV_SRC).toMatch(/onContentSizeChange=\{onContentSizeChange\}/);
    expect(ENV_SRC).toMatch(/onLayout=\{onScrollLayout\}/);
    expect(ENV_SRC).toMatch(/setContentHeight\(h\)/);
    expect(ENV_SRC).toMatch(/setScrollViewHeight\(/);
  });

  it('fade opacity interpolation fades over the LAST 30pt of overflow (smooth, not abrupt)', () => {
    // The interpolate's inputRange uses `overflowAmount - 30` as the
    // start of the fade-out band.
    expect(ENV_SRC).toMatch(/overflowAmount\s*-\s*30/);
    // And extrapolate: clamp so the opacity doesn't run negative past
    // the bottom (rubber-band scrolls).
    expect(ENV_SRC).toMatch(
      /scrollY\.interpolate\(\{[\s\S]*?extrapolate:\s*'clamp'/,
    );
  });

  it('tapHint copy explicitly mentions 拖动 (drag) so the affordance is in copy as well as visuals', () => {
    expect(ENV_SRC).toMatch(/tapHint[\s\S]*?>\s*拖动阅读/);
  });

  it('resets scroll state when (visible, content) changes so a fresh letter starts at the top', () => {
    expect(ENV_SRC).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?scrollY\.setValue\(0\)[\s\S]*?setContentHeight\(0\)[\s\S]*?setScrollViewHeight\(0\)[\s\S]*?\},\s*\[\s*visible,\s*content/,
    );
  });

  it('preserves v1.3.3 maxHeight bound on contentScroll (the layout fix that lets scroll activate)', () => {
    expect(ENV_SRC).toMatch(
      /contentScroll:\s*\{[\s\S]*?maxHeight:\s*LETTER_MAX_H\s*-\s*\d+/,
    );
  });
});
