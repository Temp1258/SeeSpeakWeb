import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing, Modal, Pressable, Dimensions, ScrollView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../constants';

interface Props {
  visible: boolean;
  content: string;
  from?: string;
  to?: string;
  date?: string;
  kindLabel?: string;
  onClose: () => void;
  // When false, render as an absolute-positioned overlay sibling instead
  // of a native Modal layer.
  // v1.3.8 — DO NOT pass false from inside a pageSheet Modal. The RN-level
  // overlay can't shield the parent pageSheet's native swipe-to-dismiss
  // recognizer; once the inner ScrollView reaches its scroll boundary, the
  // dismiss gesture takes over and the parent modal drags with the finger.
  // The default (true) wraps in a transparent (overFullScreen on iOS) Modal
  // that stacks above the parent and fully isolates touches.
  wrapInModal?: boolean;
  // When true, skip the envelope/flap choreography and reveal the letter
  // directly with a quick fade + scale-up. Use this for inbox re-reads where
  // the full ceremony would feel slow.
  skipEnvelope?: boolean;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const ENV_W = Math.min(280, SCREEN_W - 60);
const ENV_H = Math.round(ENV_W * 0.62);
const FLAP_H = Math.round(ENV_H * 0.6);
// Cap LETTER_W at 420 — on iPhone (max 430 width) this is effectively
// SCREEN_W - 40, but if iPad support is ever turned on, the letter
// won't blow out to 700+pt and become unreadable; instead it stays at
// a comfortable book-page width.
const LETTER_W = Math.min(420, SCREEN_W - 40);
const LETTER_MAX_H = Math.round(SCREEN_H * 0.7);

type Stage = 'idle' | 'envelope' | 'letter';

export default function EnvelopeOpenAnimation({
  visible,
  content,
  from,
  to,
  date,
  kindLabel,
  onClose,
  wrapInModal = true,
  skipEnvelope = false,
}: Props) {
  const [stage, setStage] = useState<Stage>('idle');
  const wrapperOpacity = useRef(new Animated.Value(0)).current;
  const envelopeScale = useRef(new Animated.Value(0.6)).current;
  const flapRotate = useRef(new Animated.Value(0)).current;
  const letterOpacity = useRef(new Animated.Value(0)).current;
  const letterTranslateY = useRef(new Animated.Value(0)).current;
  // Letter scale starting point differs by mode: envelope mode starts very
  // small (rises out of the envelope); skipEnvelope starts close to 1 for a
  // quick zoom-in.
  const letterScale = useRef(new Animated.Value(skipEnvelope ? 0.92 : 0.4)).current;

  // v1.3.4 — Scroll affordances for long letters. The visible scroll
  // indicator + a fading "more below" gradient overlay tell the user
  // "this letter has more content, drag to read on" so they don't
  // assume the first page is the whole letter. State drives the
  // overlay's mounting (hasOverflow gate) and opacity interpolation
  // (fade-out as the user approaches the bottom).
  const scrollY = useRef(new Animated.Value(0)).current;
  const [contentHeight, setContentHeight] = useState(0);
  const [scrollViewHeight, setScrollViewHeight] = useState(0);
  const overflowAmount = Math.max(0, contentHeight - scrollViewHeight);
  // 0.5pt epsilon — sub-pixel rounding shouldn't trigger the overlay.
  const hasOverflow = overflowAmount > 0.5;

  const fadeOpacity = useMemo(() => {
    if (!hasOverflow) return null;
    // Two branches to keep the inputRange strictly increasing — RN
    // tolerates duplicate boundaries but the behavior at the dup is
    // implementation-defined, so we avoid it here.
    //   (i)  overflowAmount > 30  → hold opacity 1 until the last 30pt,
    //                                then linearly fade to 0.
    //   (ii) overflowAmount ≤ 30  → degenerate: the entire overflow IS
    //                                the fade band; 2-point fade is enough.
    if (overflowAmount > 30) {
      return scrollY.interpolate({
        inputRange: [0, overflowAmount - 30, overflowAmount],
        outputRange: [1, 1, 0],
        extrapolate: 'clamp',
      });
    }
    return scrollY.interpolate({
      inputRange: [0, Math.max(overflowAmount, 0.001)],
      outputRange: [1, 0],
      extrapolate: 'clamp',
    });
  }, [scrollY, hasOverflow, overflowAmount]);

  // JS-driven Animated.event (no native driver) so we keep using a
  // plain <ScrollView>; the fade opacity update path stays on
  // Animated.Value so the React tree doesn't re-render on every
  // scroll frame.
  const onScrollContent = useMemo(
    () => Animated.event(
      [{ nativeEvent: { contentOffset: { y: scrollY } } }],
      { useNativeDriver: false },
    ),
    [scrollY],
  );

  const onContentSizeChange = useCallback((_w: number, h: number) => {
    setContentHeight(h);
  }, []);

  const onScrollLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    setScrollViewHeight(e.nativeEvent.layout.height);
  }, []);

  // Each fresh open (or letter swap via content prop change) starts at
  // scroll-top with cleared measurements. Stale scrollY from a prior
  // letter would otherwise paint the new letter's first frame with the
  // wrong fade opacity (e.g., "already scrolled to bottom" when the
  // user hasn't even seen the top).
  useEffect(() => {
    scrollY.setValue(0);
    setContentHeight(0);
    setScrollViewHeight(0);
  }, [visible, content, scrollY]);

  useEffect(() => {
    if (!visible) {
      setStage('idle');
      return;
    }

    // Cancellation flag — every chained .start callback reads this before
    // doing anything. Without it, a quick open/close/open toggle leaves
    // dangling callbacks from the prior run that flip stage / restart
    // animations on the new run, causing visible flicker.
    let cancelled = false;

    setStage('idle');
    wrapperOpacity.setValue(0);
    envelopeScale.setValue(0.6);
    flapRotate.setValue(0);
    letterOpacity.setValue(0);
    letterTranslateY.setValue(0);
    letterScale.setValue(skipEnvelope ? 0.92 : 0.4);

    if (skipEnvelope) {
      requestAnimationFrame(() => {
        if (cancelled) return;
        setStage('letter');
        requestAnimationFrame(() => {
          if (cancelled) return;
          Animated.parallel([
            Animated.timing(wrapperOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
            Animated.timing(letterOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
            Animated.spring(letterScale, { toValue: 1, friction: 8, tension: 90, useNativeDriver: true }),
          ]).start();
        });
      });
      return () => { cancelled = true; };
    }

    setStage('envelope');
    Animated.parallel([
      Animated.timing(wrapperOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
      Animated.spring(envelopeScale, { toValue: 1, friction: 7, tension: 80, useNativeDriver: true }),
    ]).start(() => {
      if (cancelled) return;
      Animated.timing(flapRotate, {
        toValue: 1,
        duration: 480,
        easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        useNativeDriver: true,
      }).start(() => {
        if (cancelled) return;
        setStage('letter');
        requestAnimationFrame(() => {
          if (cancelled) return;
          Animated.parallel([
            Animated.timing(letterOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
            Animated.timing(letterTranslateY, {
              toValue: -ENV_H * 0.6,
              duration: 600,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.spring(letterScale, { toValue: 1, friction: 8, tension: 55, useNativeDriver: true }),
          ]).start();
        });
      });
    });

    return () => { cancelled = true; };
  }, [visible, skipEnvelope]);

  const flapRotateInterpolate = flapRotate.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '-175deg'],
  });

  const renderLetterCard = () => (
    <Pressable style={styles.letterPress} onPress={(e) => e.stopPropagation()}>
      <View style={styles.letterHeader}>
        {kindLabel ? <Text style={styles.kindLabel}>{kindLabel}</Text> : null}
        {(from || to) ? (
          <Text style={styles.fromToText}>
            <Text style={styles.fromToLabel}>From </Text>
            <Text style={styles.fromToName}>{from || '—'}</Text>
            <Text style={styles.fromToLabel}>  →  To </Text>
            <Text style={styles.fromToName}>{to || '—'}</Text>
          </Text>
        ) : null}
        {date ? <Text style={styles.dateText}>{date}</Text> : null}
      </View>
      <View style={styles.divider} />
      <View style={styles.contentWrap}>
        <ScrollView
          style={styles.contentScroll}
          contentContainerStyle={styles.contentScrollInner}
          showsVerticalScrollIndicator={true}
          onScroll={onScrollContent}
          scrollEventThrottle={16}
          onContentSizeChange={onContentSizeChange}
          onLayout={onScrollLayout}
        >
          <Text style={styles.letterContent}>{content}</Text>
        </ScrollView>
        {hasOverflow && fadeOpacity ? (
          <Animated.View
            style={[styles.bottomFade, { opacity: fadeOpacity }]}
            pointerEvents="none"
          >
            <LinearGradient
              colors={['rgba(255,255,255,0)', COLORS.white]}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        ) : null}
      </View>
      <Text style={styles.tapHint}>拖动阅读 · 轻点空白处收起</Text>
    </Pressable>
  );

  const body = (
    <Pressable style={styles.pressOut} onPress={onClose}>
      <View style={styles.center} pointerEvents="box-none">
        {skipEnvelope ? (
          stage === 'letter' && (
            <Animated.View
              style={[
                styles.letterCenter,
                {
                  opacity: letterOpacity,
                  transform: [{ scale: letterScale }],
                },
              ]}
            >
              {renderLetterCard()}
            </Animated.View>
          )
        ) : (
          <Animated.View
            style={[
              styles.envelopeWrap,
              { transform: [{ scale: envelopeScale }] },
            ]}
            // box-none: the wrap itself doesn't catch touches (so taps on
            // the decorative envelope back / pocket / flap still bubble
            // up to pressOut → onClose), but children can. That lets the
            // inner letter Pressable absorb taps without dismissing, and
            // — more importantly — lets the content ScrollView claim
            // vertical-drag gestures for long letters. (was "none", which
            // sealed the entire reveal off from any interaction.)
            pointerEvents="box-none"
          >
            <View style={styles.envelopeBody} />

            {stage === 'letter' && (
              <Animated.View
                style={[
                  styles.letterContainer,
                  {
                    opacity: letterOpacity,
                    transform: [
                      { translateY: letterTranslateY },
                      { scale: letterScale },
                    ],
                  },
                ]}
              >
                {renderLetterCard()}
              </Animated.View>
            )}

            <View style={styles.envelopePocket} />

            <Animated.View
              style={[
                styles.flap,
                { transform: [{ rotateX: flapRotateInterpolate }] },
              ]}
            />
          </Animated.View>
        )}
      </View>
    </Pressable>
  );

  const wrapper = (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: 'rgba(40, 20, 30, 0.55)', opacity: wrapperOpacity },
      ]}
    >
      {body}
    </Animated.View>
  );

  if (!wrapInModal) {
    if (!visible) return null;
    return wrapper;
  }

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      {wrapper}
    </Modal>
  );
}

const styles = StyleSheet.create({
  pressOut: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  envelopeWrap: {
    width: ENV_W,
    height: ENV_H,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  envelopeBody: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: ENV_H,
    backgroundColor: '#FFE4EC',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.kiss,
  },
  envelopePocket: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: ENV_H * 0.55,
    backgroundColor: '#FFD0DD',
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,143,171,0.5)',
  },
  // v1.3.6 — letterContainer / letterCenter pin a DEFINITE height
  // (was maxHeight). RN/Yoga needs a definite main-axis size on the
  // outer card for `flex: 1` children below (letterPress → contentWrap
  // → ScrollView) to size deterministically. Under maxHeight alone,
  // the flex chain falls back to intrinsic content height and the
  // ScrollView never gets a bounded outer frame on Dynamic Type or
  // small-screen edge cases, so long letters truncate.
  letterContainer: {
    position: 'absolute',
    bottom: ENV_H * 0.15,
    width: LETTER_W,
    height: LETTER_MAX_H,
  },
  letterCenter: {
    width: LETTER_W,
    height: LETTER_MAX_H,
  },
  // letterPress now fills its definite-height parent and acts as the
  // flex-column container that distributes height to header / divider /
  // contentWrap / tapHint. No more minHeight/maxHeight math.
  letterPress: {
    width: '100%',
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 18,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  letterHeader: {
    gap: 6,
  },
  kindLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.kiss,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  fromToText: {
    fontSize: 13,
    color: COLORS.textLight,
  },
  fromToLabel: {
    fontSize: 12,
    color: COLORS.textLight,
    fontWeight: '500',
  },
  fromToName: {
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '700',
  },
  dateText: {
    fontSize: 12,
    color: COLORS.textLight,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.border,
    marginVertical: 14,
  },
  // v1.3.6 — contentWrap absorbs all remaining height inside letterPress
  // after header / divider / tapHint take their natural sizes. `flex: 1`
  // makes it grow into available space; `minHeight: 0` is REQUIRED in
  // RN's column flex so it can shrink below its intrinsic content size
  // when the inner ScrollView's content exceeds the available frame.
  // Without minHeight: 0, the wrap would refuse to shrink and the
  // ScrollView would never perceive overflow → no scroll.
  contentWrap: {
    flex: 1,
    minHeight: 0,
  },
  // v1.3.6 — ScrollView fills contentWrap exactly. Previously we had a
  // hardcoded `maxHeight: LETTER_MAX_H - 200` reserving 200pt for
  // header/divider/tapHint/padding, but that reserve was wrong on:
  //   - small screens (iPhone SE 1st: only 198pt of scroll window)
  //   - Dynamic Type Large+ (header > 90pt eats the reserve)
  //   - long partner remarks (fromToText wraps to 2-3 lines)
  // With definite-height letterPress + flex-chain below, the ScrollView
  // now adapts to whatever space is actually left, no magic numbers.
  contentScroll: {
    flex: 1,
  },
  // v1.3.4 — "More below" gradient overlay. Rendered only when content
  // overflows the ScrollView, fades out as the user scrolls to the
  // bottom (driven by Animated.Value tied to onScroll → never causes
  // React re-renders on scroll frames). pointerEvents="none" so it
  // can't intercept the ScrollView's vertical-drag gestures.
  bottomFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 24,
  },
  contentScrollInner: {
    paddingBottom: 6,
  },
  letterContent: {
    fontSize: 17,
    lineHeight: 26,
    color: COLORS.text,
  },
  tapHint: {
    marginTop: 14,
    fontSize: 11,
    color: COLORS.textLight,
    textAlign: 'center',
  },
  flap: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 0,
    height: 0,
    borderLeftWidth: ENV_W / 2,
    borderRightWidth: ENV_W / 2,
    borderTopWidth: FLAP_H,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#FFB5C2',
    transformOrigin: 'top center',
  } as any,
});
