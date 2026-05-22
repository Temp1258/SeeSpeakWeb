import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { COLORS, ACTION_EMOJI } from '../constants';

interface Props {
  userName: string;
  actionType: string;
  time: string;
  partnerTime?: string;
  isMine: boolean;
  remark?: string;
  onPress?: () => void;
  // When true, the bubble springs in with a water-drop wobble on mount.
  // Used for messages that arrive while the user is already viewing — the
  // initial-load batch passes false to avoid every existing item bouncing
  // when the screen first opens.
  animateOnMount?: boolean;
  // v1.2.20 — when > 1, render a ×NN badge after the emoji. Increments
  // trigger a one-shot scale-pop so the user notices "ta sent another
  // one" without the bubble re-mounting. count === 1 (or omitted) hides
  // the badge entirely so single-emoji bubbles look exactly like before.
  count?: number;
}

export default function ActionRecord({
  userName, actionType, time, partnerTime, isMine, remark,
  onPress, animateOnMount, count = 1,
}: Props) {
  const emoji = ACTION_EMOJI[actionType] || '?';
  const displayName = !isMine && remark ? `${userName} (${remark})` : userName;

  // 0 → 1 driving both opacity (fade) and scale (spring with overshoot).
  // useRef pins the initial value at first render so subsequent prop changes
  // never restart the animation by accident.
  const enter = useRef(new Animated.Value(animateOnMount ? 0 : 1)).current;
  useEffect(() => {
    if (!animateOnMount) return;
    Animated.spring(enter, {
      toValue: 1,
      useNativeDriver: true,
      tension: 90,
      friction: 5,
    }).start();
    // mount-only: capture animateOnMount at mount; ignore later changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scale = enter.interpolate({
    inputRange: [0, 1],
    outputRange: [0.6, 1],
  });
  const opacity = enter.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0, 1, 1],
  });

  // ×NN bounce — fires once whenever count strictly increases (i.e. a
  // new emoji landed in this burst while the user was already on the
  // screen). On mount the previous count is initialised to the current
  // count, so the initial render of a "kiss ×3" history bubble does
  // NOT bounce — only LIVE bursts visibly pump.
  const prevCountRef = useRef(count);
  const countScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (count > prevCountRef.current) {
      Animated.sequence([
        Animated.spring(countScale, { toValue: 1.55, friction: 4, tension: 120, useNativeDriver: true }),
        Animated.spring(countScale, { toValue: 1, friction: 5, tension: 90, useNativeDriver: true }),
      ]).start();
    }
    prevCountRef.current = count;
  }, [count, countScale]);

  return (
    <Animated.View style={{ opacity, transform: [{ scale }] }}>
      <View style={[styles.container, isMine ? styles.mine : styles.theirs]}>
        <TouchableOpacity
          style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}
          onPress={onPress}
          activeOpacity={0.7}
        >
          <View style={styles.emojiRow}>
            <Text style={styles.emoji}>{emoji}</Text>
            {count > 1 && (
              <Animated.Text
                style={[
                  styles.countBadge,
                  isMine ? styles.countBadgeMine : styles.countBadgeTheirs,
                  { transform: [{ scale: countScale }] },
                ]}
              >
                ×{count}
              </Animated.Text>
            )}
          </View>
          <View style={styles.info}>
            <Text style={styles.name}>{displayName}</Text>
            {partnerTime && !isMine ? (
              <Text style={styles.time}>
                对方 {partnerTime} · 我 {time}
              </Text>
            ) : (
              <Text style={styles.time}>{time}</Text>
            )}
          </View>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    marginVertical: 4,
    paddingHorizontal: 16,
  },
  mine: {
    justifyContent: 'flex-end',
  },
  theirs: {
    justifyContent: 'flex-start',
  },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    maxWidth: '75%',
  },
  bubbleMine: {
    backgroundColor: '#FFE4E9',
  },
  bubbleTheirs: {
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  emojiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  emoji: {
    fontSize: 24,
  },
  countBadge: {
    marginLeft: 4,
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.3,
  },
  countBadgeMine: {
    color: COLORS.kiss,
  },
  countBadgeTheirs: {
    color: COLORS.text,
  },
  info: {
    flexShrink: 1,
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },
  time: {
    fontSize: 12,
    color: COLORS.textLight,
    marginTop: 2,
  },
});
