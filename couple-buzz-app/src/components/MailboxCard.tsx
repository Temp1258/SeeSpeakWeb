import React, { useState, useCallback, useRef, useMemo, forwardRef, useImperativeHandle, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Animated,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS } from '../constants';
import { api, MailboxResponse } from '../services/api';
import { storage } from '../utils/storage';
import { useCountdown } from '../utils/countdown';
import SealAnimation from './SealAnimation';
import EnvelopeOpenAnimation from './EnvelopeOpenAnimation';
import { SpringPressable } from './SpringPressable';

interface RevealMeta {
  from: string;
  to: string;
  date: string;
  kindLabel: string;
  content: string;
}

const MailboxCard = forwardRef<{ reload: () => Promise<void> }>((_props, ref) => {
  const [data, setData] = useState<MailboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sealing, setSealing] = useState(false);
  // Compose form is hidden by default; revealed when the user taps the
  // "写信" pill. Keeps the card visually clean (matches 择日达 pattern).
  const [composeOpen, setComposeOpen] = useState(false);
  // Spring-driven expand for the compose form. Mirrors the 甩表情 panel —
  // bouncy slide-down beneath the pill. JS-driven (maxHeight is layout).
  const expandAnim = useRef(new Animated.Value(0)).current;
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    Animated.spring(expandAnim, {
      toValue: composeOpen ? 1 : 0,
      useNativeDriver: false,
      tension: 80,
      friction: 9,
    }).start();
    // Don't auto-focus on expand — let the user tap into the input
    // themselves so the keyboard doesn't pop up uninvited. Still blur on
    // collapse to dismiss the keyboard if the user had typed.
    if (!composeOpen) {
      inputRef.current?.blur();
    }
  }, [composeOpen, expandAnim]);
  // Snapshot of the typed letter while the seal animation runs — used as the
  // preview shown in the animation. After it's posted, content state itself
  // is cleared so it can't be peeked from local state either.
  const [sealedPreview, setSealedPreview] = useState('');
  // Track previous phase so we can play the open animation exactly once when
  // the round transitions writing → revealed in front of the user.
  const prevPhaseRef = useRef<MailboxResponse['phase'] | null>(null);
  const [revealAnim, setRevealAnim] = useState<RevealMeta | null>(null);
  const [names, setNames] = useState<{ me: string; ta: string }>({ me: '我', ta: 'ta' });

  useEffect(() => {
    (async () => {
      const [myName, remark, partnerName] = await Promise.all([
        storage.getUserName(),
        storage.getPartnerRemark(),
        storage.getPartnerName(),
      ]);
      setNames({
        me: myName || '我',
        ta: (remark && remark.trim()) || partnerName || 'ta',
      });
    })();
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await api.getMailbox();
      setData(result);
      // Server only sends own content once revealed. Until then we never have
      // it locally — that's the whole point of "sealed in transit".
      if (result.phase === 'revealed' && result.my_message) {
        setContent(result.my_message);
        setComposeOpen(false);
      } else if (result.my_sealed) {
        setContent('');
        setComposeOpen(false);
      }
      // Pre-write & still draftable: keep whatever the user is composing.
    } catch {}
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useImperativeHandle(ref, () => ({ reload: load }), [load]);

  // Detect writing → revealed transition and play the open animation. Skip
  // the very first load so we don't fire mid-history when the user enters
  // the screen during an already-revealed phase.
  useEffect(() => {
    if (!data) return;
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = data.phase;
    if (prev === 'writing' && data.phase === 'revealed') {
      // Show partner's message in the open animation; if partner skipped,
      // show our own as the headline letter.
      const text = data.partner_message ?? data.my_message ?? '';
      if (!text) return;
      const fromPartner = !!data.partner_message;
      setRevealAnim({
        from: fromPartner ? names.ta : names.me,
        to: fromPartner ? names.me : names.ta,
        date: formatWeekKey(data.week_key),
        kindLabel: '半日达',
        content: text,
      });
    }
  }, [data, names.me, names.ta]);

  // The schedule banner always counts down to the NEXT delivery, regardless
  // of phase. During `writing`, that's this session's reveal_at. After
  // `revealed`, the current session's reveal_at is in the past — the next
  // delivery is exactly 12h later (sessions are a fixed AM/PM 12h cycle).
  const nextRevealAt = useMemo(() => {
    if (!data?.reveal_at) return null;
    const t = new Date(data.reveal_at).getTime();
    return new Date(data.phase === 'revealed' ? t + 12 * 3600 * 1000 : t);
  }, [data?.reveal_at, data?.phase]);
  const cd = useCountdown(nextRevealAt);

  const handleSubmit = async () => {
    const text = content.trim();
    if (!text || submitting || sealing) return;
    setSubmitting(true);
    try {
      await api.submitMailbox(text);
    } catch (e: any) {
      setSubmitting(false);
      Alert.alert('投递失败', e?.message || '请稍后再试');
      return;
    }
    setSubmitting(false);
    setSealedPreview(text);
    setContent('');
    setSealing(true);
  };

  const handleSealComplete = async () => {
    // Refresh data BEFORE flipping sealing=false. Otherwise the brief gap
    // between sealing→false and load() resolving lets the default branch
    // render once with stale state (composeOpen=true, my_sealed=false),
    // flashing the empty form on screen for one frame before settling on
    // the sealed UI. Loading first keeps SealAnimation's final frame
    // visible until everything is ready to swap in one render.
    await load();
    setSealedPreview('');
    setSealing(false);
  };

  if (loading) {
    return (
      <View style={styles.card}>
        <ActivityIndicator color={COLORS.kiss} />
      </View>
    );
  }

  if (!data) return null;

  const { phase, my_message, partner_message, partner_wrote, my_sealed } = data;
  // Wording flips on whether the user has already submitted this round:
  //   sealed → personal: "这封信将在 X 后送达"
  //   not sealed (or revealed phase) → next batch: "下一封信将在 X 后派送"
  const scheduleLabel = my_sealed
    ? (cd.done ? '即将送达' : `这封信将在 ${cd.hh}:${cd.mm}:${cd.ss} 后送达`)
    : (cd.done ? '即将派送' : `下一封信将在 ${cd.hh}:${cd.mm}:${cd.ss} 后派送`);

  return (
    <View style={styles.card}>
      <Text style={styles.header}>半日达 📮</Text>
      <Text style={styles.schedule}>{scheduleLabel}</Text>

      {phase === 'revealed' ? (
        <View style={styles.revealContainer}>
          <View style={styles.messageBox}>
            <Text style={styles.messageLabel}>我写的</Text>
            <Text style={styles.messageText}>{my_message || '这场没有写'}</Text>
          </View>
          <View style={styles.messageBox}>
            <Text style={styles.messageLabel}>ta 写的</Text>
            <Text style={styles.messageText}>
              {partner_wrote === false ? 'ta 这场没有写' : (partner_message || 'ta 这场没有写')}
            </Text>
          </View>
        </View>
      ) : my_sealed ? (
        // Sealed: even the author can't peek at their own letter until reveal.
        <View style={styles.sealedContainer}>
          <View style={styles.sealedEnvelope}>
            <Text style={styles.sealedEnvelopeIcon}>💌</Text>
          </View>
          <Text style={styles.sealedTitle}>已封存</Text>
        </View>
      ) : sealing ? (
        <SealAnimation preview={sealedPreview} onComplete={handleSealComplete} />
      ) : (
        <View>
          <View style={styles.pillContainer}>
            <SpringPressable
              onPress={() => setComposeOpen(o => !o)}
              scaleTo={1.08}
              style={styles.composePill}
            >
              <Text style={styles.composePillText}>{composeOpen ? '收起' : '写信'}</Text>
            </SpringPressable>
          </View>
          {/* Always rendered, animated maxHeight + opacity. Spring physics
              mirror the 甩表情 panel — slides open below the pill. */}
          <Animated.View
            style={{
              maxHeight: expandAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 500] }),
              opacity: expandAnim,
              overflow: 'hidden',
            }}
            pointerEvents={composeOpen ? 'auto' : 'none'}
          >
            <Text style={styles.prompt}>写一句想说但没说出口的话吧～</Text>
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={content}
              onChangeText={setContent}
              placeholder="写点什么给 ta..."
              placeholderTextColor={COLORS.textLight}
              maxLength={500}
              multiline
              editable={!submitting}
            />
            <View style={styles.charCount}>
              <Text style={styles.charCountText}>{content.length}/500</Text>
            </View>
            <View style={styles.submitPillContainer}>
              <SpringPressable
                onPress={handleSubmit}
                disabled={!content.trim() || submitting}
                scaleTo={1.08}
                style={[
                  styles.submitPill,
                  (!content.trim() || submitting) && styles.submitPillDisabled,
                ]}
              >
                <Text style={styles.submitPillText}>{submitting ? '投递中...' : '寄出'}</Text>
              </SpringPressable>
            </View>
            <Text style={styles.hint}>提交后不能修改 · 双方都看不到内容直到送达</Text>
          </Animated.View>
        </View>
      )}

      <EnvelopeOpenAnimation
        visible={!!revealAnim}
        kindLabel={revealAnim?.kindLabel}
        from={revealAnim?.from}
        to={revealAnim?.to}
        date={revealAnim?.date}
        content={revealAnim?.content ?? ''}
        onClose={() => setRevealAnim(null)}
      />
    </View>
  );
});

export default MailboxCard;

function formatWeekKey(weekKey: string): string {
  const date = weekKey.slice(0, 10);
  const phase = weekKey.slice(11);
  return `${date} ${phase === 'AM' ? '上半场' : '下半场'}`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  header: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textLight,
    marginBottom: 4,
  },
  schedule: {
    fontSize: 12,
    color: COLORS.textLight,
    marginBottom: 12,
  },
  pillContainer: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  composePill: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 26,
    backgroundColor: COLORS.kiss,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 8,
  },
  composePillText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  prompt: {
    fontSize: 15,
    color: COLORS.text,
    marginBottom: 12,
    textAlign: 'center',
  },
  input: {
    backgroundColor: COLORS.background,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  charCount: {
    alignItems: 'flex-end',
    marginTop: 4,
  },
  charCountText: {
    fontSize: 12,
    color: COLORS.textLight,
  },
  submitPillContainer: {
    alignItems: 'center',
    marginTop: 12,
  },
  submitPill: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 26,
    backgroundColor: COLORS.kiss,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 8,
  },
  submitPillDisabled: {
    opacity: 0.4,
  },
  submitPillText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  hint: {
    fontSize: 12,
    color: COLORS.textLight,
    textAlign: 'center',
    marginTop: 8,
  },
  sealedContainer: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  sealedEnvelope: {
    width: 80,
    height: 80,
    borderRadius: 16,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sealedEnvelopeIcon: {
    fontSize: 40,
  },
  sealedTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.text,
    marginTop: 12,
  },
  revealContainer: {
    gap: 12,
  },
  messageBox: {
    backgroundColor: COLORS.background,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  messageLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.kiss,
    marginBottom: 4,
  },
  messageText: {
    fontSize: 15,
    color: COLORS.text,
    lineHeight: 22,
  },
});
