import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View, Easing } from 'react-native';

export interface IslandToastHandle {
  show: (message: string, durationMs?: number) => void;
  hide: () => void;
}

interface Props {
  // Top offset from the screen edge — pass insets.top + a small margin so the
  // pill sits roughly where the Dynamic Island would be on supported iPhones.
  top?: number;
}

// In-app pill modeled after iOS Dynamic Island. Shows a short message that
// slides down from the top with a subtle scale, holds, then slides back up.
// Real Dynamic Island requires ActivityKit / a native widget extension; this
// component is a visual mimic for in-app feedback only.
const IslandToast = forwardRef<IslandToastHandle, Props>(({ top = 8 }, ref) => {
  const [message, setMessage] = useState<string | null>(null);
  const translateY = useRef(new Animated.Value(-60)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.85)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // FIFO queue. Old behavior was "latest wins" — a burst of show()
  // calls (e.g. a batch operation that toasts per item) collapsed to
  // only the final message visible. The queue plays each in turn so
  // every piece of feedback is actually surfaced.
  const queueRef = useRef<{ msg: string; durationMs: number }[]>([]);
  const playingRef = useRef(false);

  const animateIn = () => {
    translateY.setValue(-60);
    opacity.setValue(0);
    scale.setValue(0.85);
    Animated.parallel([
      Animated.timing(translateY, { toValue: 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 7, tension: 90, useNativeDriver: true }),
    ]).start();
  };

  const animateOut = (cb?: () => void) => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: -60, duration: 240, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 0.9, duration: 220, useNativeDriver: true }),
    ]).start(() => {
      setMessage(null);
      cb?.();
    });
  };

  const playNext = () => {
    const next = queueRef.current.shift();
    if (!next) {
      playingRef.current = false;
      return;
    }
    playingRef.current = true;
    setMessage(next.msg);
    requestAnimationFrame(() => animateIn());
    hideTimer.current = setTimeout(() => animateOut(playNext), next.durationMs);
  };

  useImperativeHandle(ref, () => ({
    show: (msg: string, durationMs = 2400) => {
      queueRef.current.push({ msg, durationMs });
      if (!playingRef.current) playNext();
    },
    hide: () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      queueRef.current = [];
      playingRef.current = false;
      animateOut();
    },
  }), []);

  // On unmount: clear any pending timer + drop the queue so timers /
  // queued setMessage don't fire after the component is gone.
  useEffect(() => () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    queueRef.current = [];
    playingRef.current = false;
  }, []);

  if (!message) return null;

  return (
    <View style={[styles.wrap, { top }]} pointerEvents="none">
      <Animated.View
        style={[
          styles.pill,
          {
            opacity,
            transform: [{ translateY }, { scale }],
          },
        ]}
      >
        <Text style={styles.text}>{message}</Text>
      </Animated.View>
    </View>
  );
});

export default IslandToast;

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 99999,
    elevation: 99999,
  },
  pill: {
    backgroundColor: '#0E0E10',
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    minWidth: 140,
    maxWidth: '85%',
    alignItems: 'center',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
    textAlign: 'center',
  },
});
