/**
 * Regression tests for v1.3.8:
 *
 *   Letter overlay must live in its own native Modal layer, not as a
 *   sibling absoluteFill inside InboxScreen's pageSheet.
 *
 *   Root cause of the bug: with `wrapInModal={false}`, EnvelopeOpenAnimation
 *   rendered as a sibling View inside the InboxScreen pageSheet Modal. The
 *   RN-level absoluteFill could not shield iOS's native pageSheet swipe-to-
 *   dismiss recognizer; once the inner letter ScrollView reached its scroll
 *   boundary (top or bottom), the dismiss recognizer took over and the
 *   parent inbox modal dragged with the user's finger.
 *
 *   Fix: drop `wrapInModal={false}` so EnvelopeOpenAnimation falls back to
 *   its default Modal wrap. That Modal is `transparent` (= overFullScreen
 *   on iOS), which has no swipe-to-dismiss of its own and fully blocks
 *   touches from ever reaching the pageSheet underneath. The letter
 *   ScrollView is now self-contained.
 */

import fs from 'fs';
import path from 'path';

const INBOX_SRC = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'couple-buzz-app',
    'src',
    'screens',
    'InboxScreen.tsx',
  ),
  'utf8',
);

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

describe('#1 — InboxScreen no longer passes wrapInModal={false}', () => {
  // Pull out the JSX call to <EnvelopeOpenAnimation … /> so we ignore
  // historical mentions in comments/docstrings (e.g. the v1.3.8 fix note
  // that quotes the bad attribute as a warning).
  const envCallMatch = INBOX_SRC.match(/<EnvelopeOpenAnimation\b[\s\S]*?\/>/);
  const envCall = envCallMatch ? envCallMatch[0] : '';

  it('InboxScreen still mounts EnvelopeOpenAnimation', () => {
    expect(envCall).not.toBe('');
  });

  it('the EnvelopeOpenAnimation JSX call does not pass wrapInModal={false} (would re-expose the swipe-leak bug)', () => {
    expect(envCall).not.toMatch(/wrapInModal\s*=\s*\{?\s*false\s*\}?/);
  });

  it('InboxScreen remains a pageSheet (= the parent whose swipe-dismiss we are isolating from)', () => {
    expect(INBOX_SRC).toMatch(/presentationStyle="pageSheet"/);
  });
});

describe('#2 — EnvelopeOpenAnimation Modal wrap is transparent (overFullScreen on iOS)', () => {
  it('Modal wrap renders with `transparent` so iOS picks overFullScreen presentation', () => {
    expect(ENV_SRC).toMatch(/<Modal\s+visible=\{visible\}\s+transparent\s+animationType="none"/);
  });

  it('default for the wrapInModal prop is true (Modal wrap mode)', () => {
    expect(ENV_SRC).toMatch(/wrapInModal\s*=\s*true/);
  });

  it('docstring on wrapInModal warns against passing false from inside a pageSheet', () => {
    // The comment lives directly above the prop and references the v1.3.8
    // root cause. If someone strips the warning, the next dev will re-
    // introduce the bug.
    expect(ENV_SRC).toMatch(/DO NOT pass false from inside a pageSheet Modal/);
  });
});
