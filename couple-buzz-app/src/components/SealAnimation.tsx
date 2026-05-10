import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { COLORS } from '../constants';

interface Props {
  // Preview text shown on the "letter" before it folds into the envelope.
  preview: string;
  // Fired when the full sequence completes — caller typically transitions
  // back to a sealed/idle state and reloads server data.
  onComplete?: () => void;
}

// Three-beat seal animation: letter folds away → envelope pops in → stamp drops.
// Used identically by 半日达 and 择日达 after a successful submit.
export default function SealAnimation({ preview, onComplete }: Props) {
  const letterOpacity = useRef(new Animated.Value(1)).current;
  const letterTranslateY = useRef(new Animated.Value(0)).current;
  const letterScale = useRef(new Animated.Value(1)).current;
  const envelopeOpacity = useRef(new Animated.Value(0)).current;
  const envelopeScale = useRef(new Animated.Value(0.4)).current;
  const stampRotate = useRef(new Animated.Value(0)).current;
  const stampOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(letterOpacity, { toValue: 0, duration: 350, useNativeDriver: true }),
        Animated.timing(letterTranslateY, { toValue: -32, duration: 350, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(letterScale, { toValue: 0.6, duration: 350, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(envelopeOpacity, { toValue: 1, duration: 260, useNativeDriver: true }),
        Animated.spring(envelopeScale, { toValue: 1, friction: 6, tension: 90, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(stampOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.timing(stampRotate, { toValue: 1, duration: 220, easing: Easing.out(Easing.back(1.5)), useNativeDriver: true }),
      ]),
      Animated.delay(450),
    ]).start(() => onComplete?.());
  }, []);

  const stampRotateInterpolate = stampRotate.interpolate({
    inputRange: [0, 1],
    outputRange: ['-45deg', '-12deg'],
  });

  return (
    <View style={styles.stage}>
      <Animated.View
        style={[
          styles.letter,
          {
            opacity: letterOpacity,
            transform: [{ translateY: letterTranslateY }, { scale: letterScale }],
          },
        ]}
      >
        <Text style={styles.letterText} numberOfLines={4}>
          {preview}
        </Text>
      </Animated.View>
      <Animated.View
        style={[
          styles.envelope,
          {
            opacity: envelopeOpacity,
            transform: [{ scale: envelopeScale }],
          },
        ]}
      >
        <Text style={styles.envelopeIcon}>✉️</Text>
        <Animated.Text
          style={[
            styles.stamp,
            {
              opacity: stampOpacity,
              transform: [{ rotate: stampRotateInterpolate }],
            },
          ]}
        >
          SEALED
        </Animated.Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    height: 180,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  letter: {
    position: 'absolute',
    width: '85%',
    backgroundColor: COLORS.background,
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  letterText: {
    fontSize: 14,
    color: COLORS.text,
    lineHeight: 20,
  },
  envelope: {
    position: 'absolute',
    width: 96,
    height: 96,
    borderRadius: 18,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  envelopeIcon: {
    fontSize: 48,
  },
  stamp: {
    position: 'absolute',
    right: -14,
    top: -10,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    color: COLORS.kiss,
    borderWidth: 2,
    borderColor: COLORS.kiss,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: COLORS.white,
  },
});
