import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing, Modal, Pressable, Dimensions, ScrollView } from 'react-native';
import { COLORS } from '../constants';

interface Props {
  visible: boolean;
  content: string;
  from?: string;
  to?: string;
  date?: string;
  kindLabel?: string;
  onClose: () => void;
  // When false, render as an absolute-positioned overlay instead of a Modal.
  // Use false when the parent is already inside a Modal (e.g. InboxScreen).
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
      <ScrollView
        style={styles.contentScroll}
        contentContainerStyle={styles.contentScrollInner}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.letterContent}>{content}</Text>
      </ScrollView>
      <Text style={styles.tapHint}>轻点空白处收起</Text>
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
  letterContainer: {
    position: 'absolute',
    bottom: ENV_H * 0.15,
    width: LETTER_W,
    maxHeight: LETTER_MAX_H,
  },
  letterCenter: {
    width: LETTER_W,
    maxHeight: LETTER_MAX_H,
  },
  letterPress: {
    width: '100%',
    minHeight: 360,
    maxHeight: LETTER_MAX_H,
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
  contentScroll: {
    flexShrink: 1,
    // Definite outer-height bound. Without this, RN's ScrollView in a
    // flex column sized to its own content (intrinsic = content height),
    // so the parent card clipped at maxHeight but the ScrollView never
    // perceived the overflow — long letters showed one page with no way
    // to scroll. Pinning maxHeight to (LETTER_MAX_H − 200) reserves room
    // for header (kind/from-to/date), divider, tap hint and the card's
    // vertical padding, with enough buffer to absorb Dynamic Type at
    // typical accessibility settings. Once content exceeds the bound,
    // internal scrolling activates.
    maxHeight: LETTER_MAX_H - 200,
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
