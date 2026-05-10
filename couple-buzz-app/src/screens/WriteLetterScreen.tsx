import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  StyleSheet,
  Animated,
  Easing,
  Alert,
  Pressable,
  Keyboard,
  TouchableOpacity,
  Dimensions,
  InputAccessoryView,
  Platform,
  FlatList,
  KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { COLORS } from '../constants';
import { api } from '../services/api';
import { SpringPressable } from '../components/SpringPressable';
import { storage } from '../utils/storage';
import { formatPostmark, toUtcIsoFromLocalParts, daysInMonth, localDateParts, friendlyTzName } from '../utils/postmark';
import { notifyOutboxChanged } from '../utils/outboxEvents';
import SealAnimation from '../components/SealAnimation';
import IslandToast, { IslandToastHandle } from '../components/IslandToast';

interface Props {
  visible: boolean;
  onClose: () => void;
  // Used in the date-pick stage to label the "给对方" recipient option.
  partnerName?: string;
}

// Multi-stage flow:
//   写 (compose) → 封 (seal animation) → 选送达方式 (kind) → 择日达细节
//   (only if capsule) → 投递 (delivery animation + API).
// All stages live inside one Modal sheet so the transition feels like
// pages of the same writing flow, never a screen jump.
type Stage = 'write' | 'sealing' | 'kind' | 'capsuleDetails' | 'sending';

type Recipient = 'self' | 'partner';

// Which datetime field's picker is open in the capsuleDetails stage.
// `null` = no picker open.
type DateTimePart = 'year' | 'month' | 'day' | 'hour' | 'minute' | null;

const SCREEN_H = Dimensions.get('window').height;
const SCREEN_W = Dimensions.get('window').width;
// Letter-paper inner padding scales with viewport width so the
// "salutation / body / signature" margins feel consistent on small and
// large iPhones — clamped to [20, 36] so it never collapses too tight
// or balloons absurdly on a hypothetical iPad layout.
const LETTER_PAPER_PAD = Math.max(20, Math.min(36, Math.round(SCREEN_W * 0.06)));
// nativeID linking the editor's TextInput to its iOS InputAccessoryView. The
// accessory bar shows above the keyboard with a "完成" button so the user
// can dismiss the keyboard from a fixed location no matter where they're
// looking on the page.
const KB_ACCESSORY_ID = 'writeLetterDoneBar';

// nothing here — helpers moved to utils/postmark.ts

export default function WriteLetterScreen({ visible, onClose, partnerName }: Props) {
  const insets = useSafeAreaInsets();

  const [stage, setStage] = useState<Stage>('write');
  const [content, setContent] = useState('');
  // 5-part datetime in the SENDER'S timezone — converted to a UTC ISO at
  // submit time so any recipient (regardless of tz) sees the same instant.
  const [pickYear, setPickYear] = useState<number>(new Date().getFullYear());
  const [pickMonth, setPickMonth] = useState<number>(1);
  const [pickDay, setPickDay] = useState<number>(1);
  const [pickHour, setPickHour] = useState<number>(9);
  const [pickMinute, setPickMinute] = useState<number>(0);
  const [datePart, setDatePart] = useState<DateTimePart>(null);
  const [recipient, setRecipient] = useState<Recipient>('partner');
  const [submitting, setSubmitting] = useState(false);
  // Flips once the API call has confirmed the send. Drives the post-
  // animation "已寄出 ✓" copy at the bottom of the sending stage so the
  // hint matches the top IslandToast during the close-out beat.
  const [submitted, setSubmitted] = useState(false);

  // User-side data for the formal letter heading + footer signature. Pulled
  // from local storage on each open so a fresh nickname / timezone / partner
  // remark immediately reflects in the letter.
  const [myName, setMyName] = useState('');
  const [myTz, setMyTz] = useState('Asia/Shanghai');
  const [partnerTz, setPartnerTz] = useState('Asia/Shanghai');
  const [partnerRemark, setPartnerRemark] = useState('');

  // Tracks mount state so deferred callbacks (SealAnimation onComplete,
  // delivery animation timers) don't try to advance stage on an already-
  // unmounted component. React 18 silent-no-ops these, but the guard is
  // explicit, costs nothing, and keeps the intent clear.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const toastRef = useRef<IslandToastHandle>(null);
  // 1-minute tick so the footer time keeps up with the wall clock if the
  // user lingers in the editor. Uses a state stub since we only need a
  // re-render trigger, not the value.
  const [, setNowTick] = useState(0);

  // Reset stage + per-letter state every time the modal opens, but DO load
  // the persisted draft body from AsyncStorage so an accidental exit doesn't
  // throw away the user's typing. The draft is cleared on successful submit
  // (in runSubmit) — anything else (close, swipe-down) preserves it.
  useEffect(() => {
    if (!visible) return;
    setStage('write');
    setRecipient('partner');
    setSubmitting(false);
    setSubmitted(false);
    setDatePart(null);
    // Reset animated values so the next sending stage starts fresh.
    letterY.setValue(0);
    letterScale.setValue(1);
    letterRotate.setValue(0);
    letterOpacity.setValue(1);
    mailboxBounce.setValue(0);

    // Load saved draft + sender/partner identity bits, then seed the
    // datetime picker to "tomorrow 09:00" in the sender's timezone.
    // Draft now lives on the server (Step 4) so the user can pick up
    // where they left off on any of their devices.
    //
    // The cancelled flag prevents a stale-promise overwrite when the
    // user closes-and-reopens the modal faster than the network round
    // trip resolves: without it, the first open's then() handler would
    // fire after the second open had already populated state and clobber
    // it with an outdated draft.
    let cancelled = false;
    // First await any pending PUT from the previous modal session — close-
    // then-immediately-reopen could otherwise race the previous save: GET
    // arrives at server before that PUT, returns stale empty, user loses
    // the last-typed characters. Resolving the in-flight save first
    // guarantees GET sees the latest content.
    Promise.resolve(pendingSaveRef.current ?? null).then(() => Promise.all([
      api.getLetterDraft().catch(() => ({ draft: '' })),
      storage.getUserName(),
      storage.getTimezone(),
      storage.getPartnerRemark(),
      storage.getPartnerTimezone(),
    ])).then(([draftResp, n, tz, r, ptz]) => {
      if (cancelled) return;
      setContent(draftResp.draft || '');
      if (n) setMyName(n);
      if (r) setPartnerRemark(r);
      if (ptz) setPartnerTz(ptz);
      const userTz = tz || 'Asia/Shanghai';
      if (tz) setMyTz(userTz);
      const today = localDateParts(userTz);
      // Tomorrow: roll today's date by +1 in UTC then read parts back.
      const tmrUtc = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
      setPickYear(tmrUtc.getUTCFullYear());
      setPickMonth(tmrUtc.getUTCMonth() + 1);
      setPickDay(tmrUtc.getUTCDate());
      setPickHour(9);
      setPickMinute(0);
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Debounced draft autosave. Without this, content typed quickly before
  // the user accidentally closes the modal (e.g. swipe-down within 500ms of
  // typing) wouldn't make it to AsyncStorage.
  //
  // pendingSaveRef holds the most recent in-flight setLetterDraft promise
  // so the "open modal" effect can await it before reading the draft back.
  // Without that serialization, close-then-quick-reopen could race the
  // outstanding PUT and the GET would return the pre-save state.
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    if (!visible) return;
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      pendingSaveRef.current = api.setLetterDraft(content).catch(() => {});
    }, 400);
    return () => {
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    };
  }, [content, visible]);

  // 1-minute tick to refresh the footer's "now" timestamp while the user
  // is composing.
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setNowTick(n => n + 1), 60000);
    return () => clearInterval(t);
  }, [visible]);

  // ── Animation values for the "letter into mailbox" delivery ───────────
  const letterY = useRef(new Animated.Value(0)).current;
  const letterScale = useRef(new Animated.Value(1)).current;
  const letterRotate = useRef(new Animated.Value(0)).current;
  const letterOpacity = useRef(new Animated.Value(1)).current;
  const mailboxBounce = useRef(new Animated.Value(0)).current;

  const runDeliveryAnimation = useCallback(
    (): Promise<void> =>
      new Promise<void>((resolve) => {
        const direction = Math.random() > 0.5 ? 1 : -1;
        // Phase 1: the letter falls toward the mailbox while shrinking
        // (~520ms). Phase 2: a small mailbox bounce as it "swallows" the
        // letter (~180ms). Total ~700ms — short enough to feel snappy.
        Animated.sequence([
          Animated.parallel([
            Animated.timing(letterY, {
              toValue: SCREEN_H * 0.32,
              duration: 520,
              easing: Easing.in(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(letterScale, {
              toValue: 0.18,
              duration: 520,
              easing: Easing.in(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(letterRotate, {
              toValue: direction * 12,
              duration: 520,
              easing: Easing.in(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(letterOpacity, {
              toValue: 0,
              duration: 520,
              easing: Easing.in(Easing.cubic),
              useNativeDriver: true,
            }),
          ]),
          Animated.spring(mailboxBounce, {
            toValue: 1,
            friction: 5,
            tension: 140,
            useNativeDriver: true,
          }),
        ]).start(() => resolve());
      }),
    [letterY, letterScale, letterRotate, letterOpacity, mailboxBounce]
  );

  // ── Stage handlers ────────────────────────────────────────────────────

  // 去寄出 → run the seal animation (~1.3s) then drop into the kind picker.
  // The seal animation lives in `stage='sealing'`; SealAnimation calls
  // onComplete which advances to 'kind'.
  const handleSeal = () => {
    Keyboard.dismiss();
    if (!content.trim()) {
      Alert.alert('', '写一些字再寄吧～');
      return;
    }
    Haptics.selectionAsync();
    setStage('sealing');
  };

  const handlePickKind = (kind: 'mailbox' | 'capsule') => {
    // Mailbox is server-capped at 500 chars (capsule at 1000). Catch the
    // length mismatch in the client so the user doesn't tap 半日达 and
    // bounce off a 400 only after the sealing animation kicks off.
    if (kind === 'mailbox' && content.trim().length > 500) {
      Alert.alert('', '半日达最多 500 字～\n这封超过了，要不寄择日达？');
      return;
    }
    Haptics.selectionAsync();
    if (kind === 'mailbox') {
      runSubmit('mailbox');
    } else {
      setStage('capsuleDetails');
    }
  };

  const runSubmit = useCallback(
    async (kind: 'mailbox' | 'capsule') => {
      if (submitting) return;
      // Sender's tz-aware datetime → absolute UTC ISO. The recipient's
      // client decodes this ISO into their own local clock at display
      // time, so the letter "arrives" at the user-picked instant in real
      // wall-clock terms regardless of recipient's tz.
      let unlockAtIso = '';
      let unlockDateLocal = '';
      if (kind === 'capsule') {
        unlockAtIso = toUtcIsoFromLocalParts(pickYear, pickMonth, pickDay, pickHour, pickMinute, myTz);
        unlockDateLocal = `${pickYear}-${String(pickMonth).padStart(2, '0')}-${String(pickDay).padStart(2, '0')}`;
        if (new Date(unlockAtIso).getTime() <= Date.now()) {
          Alert.alert('', '挑个未来的时间吧～');
          return;
        }
      }

      setSubmitting(true);
      setStage('sending');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const animPromise = runDeliveryAnimation();
      let apiPromise: Promise<unknown>;
      if (kind === 'mailbox') {
        apiPromise = api.submitMailbox(content.trim());
      } else {
        apiPromise = api.createCapsule(content.trim(), unlockDateLocal, unlockAtIso, recipient);
      }

      try {
        await Promise.all([animPromise, apiPromise]);
        // Letter shipped — clear the persisted draft so a fresh open
        // (anywhere) shows an empty page.
        await api.setLetterDraft('').catch(() => {});
        setContent('');
        // Broadcast so MailboxScreen + App.tsx can light up the 发件箱 🚩
        // and 信箱 tab dot without prop drilling.
        notifyOutboxChanged();
        // Brief on-screen confirmation before the modal closes — the
        // delivery animation already flew the letter away, the toast is
        // the textual "got it, it's queued" beat. Hold long enough for the
        // user to read it; the modal closes mid-fadeout for a smooth
        // handoff. Also flip the bottom hint so it reads "已寄出 ✓"
        // instead of the now-stale "寄出中..." during this beat.
        if (mountedRef.current) setSubmitted(true);
        toastRef.current?.show('信已寄出 · 发件箱可查看', 1400);
        await new Promise<void>(resolve => setTimeout(resolve, 700));
        if (mountedRef.current) onClose();
      } catch (e: any) {
        Alert.alert('', e?.message || '寄送失败');
        // Roll back to the relevant stage so the user can retry.
        setStage(kind === 'mailbox' ? 'kind' : 'capsuleDetails');
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, content, pickYear, pickMonth, pickDay, pickHour, pickMinute, myTz, recipient, runDeliveryAnimation, onClose]
  );

  // Pull-down / explicit cancel: close the modal but preserve the draft.
  // Force-flushes a save right now in case the autosave debounce (400ms)
  // hadn't fired yet — without this, the last characters typed could be
  // lost on a fast close. Fire-and-forget so the close animation isn't
  // blocked on the network.
  const handleCancel = useCallback(() => {
    Keyboard.dismiss();
    if (draftSaveTimer.current) {
      clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = null;
    }
    // Save in any stage where content is still meaningful as a draft —
    // i.e. anywhere except 'sending', where the API has already taken
    // the content and the post-success setLetterDraft('') will run.
    // Saving in 'sending' would race the clear and could resurrect a
    // sent letter as a draft on next open.
    if (stage !== 'sending') {
      // Track this flush in pendingSaveRef so a subsequent reopen awaits
      // it before reading the draft back — same race rationale as the
      // debounced save above.
      pendingSaveRef.current = api.setLetterDraft(content).catch(() => {});
    }
    onClose();
  }, [stage, content, onClose]);

  // ── Stage-specific renders ────────────────────────────────────────────

  const renderWriteStage = () => {
    // Addressee defaults to the partner's nickname (remark > name > "对方"),
    // unless the user has already chosen 给自己 in the capsule-details stage
    // and come back to edit. Signature is always the writer's own name.
    const addressee = recipient === 'self'
      ? (myName || '自己')
      : (partnerRemark || partnerName || '对方');
    const signature = myName || '我';
    const nowStamp = formatPostmark(new Date().toISOString(), myTz);

    return (
      <>
        <View style={styles.headerRow}>
          <Text style={styles.title}>写信</Text>
        </View>
        {/* Outer Pressable so tapping the gray modal bg around the paper
            also dismisses the keyboard. Inner Pressable on the paper does
            the same for the paper's padding (header / footer / count). */}
        <Pressable style={styles.bodyArea} onPress={Keyboard.dismiss}>
          <Pressable style={styles.letterPaper} onPress={Keyboard.dismiss}>
            <Text style={styles.letterAddress}>致 {addressee}：</Text>
            <TextInput
              value={content}
              onChangeText={setContent}
              placeholder="写下你想说的话..."
              placeholderTextColor="rgba(92, 64, 51, 0.4)"
              multiline
              maxLength={1000}
              style={styles.letterBody}
              inputAccessoryViewID={Platform.OS === 'ios' ? KB_ACCESSORY_ID : undefined}
            />
            <View style={styles.letterFooter}>
              <Text style={styles.letterFooterTime}>{nowStamp}</Text>
              <Text style={styles.letterFooterSig}>—— {signature}</Text>
              <Text style={styles.letterCount}>{content.length} / 1000</Text>
            </View>
          </Pressable>
        </Pressable>
        <View style={[styles.toolbar, { paddingBottom: insets.bottom + 16 }]}>
          <SpringPressable onPress={handleCancel} style={[styles.pill, styles.pillSecondary]}>
            <Text style={styles.pillSecondaryText}>不写了</Text>
          </SpringPressable>
          <SpringPressable onPress={handleSeal} style={[styles.pill, styles.pillPrimary]}>
            <Text style={styles.pillPrimaryText}>去寄出</Text>
          </SpringPressable>
        </View>

        {/* iOS keyboard accessory — fixed bar above the keyboard with a
            "完成" button. Gives the user a deterministic dismiss target
            regardless of where they're focused on the page. */}
        {Platform.OS === 'ios' && (
          <InputAccessoryView nativeID={KB_ACCESSORY_ID}>
            <View style={styles.kbBar}>
              <TouchableOpacity onPress={Keyboard.dismiss} style={styles.kbBarBtn} hitSlop={{ top: 6, bottom: 6, left: 12, right: 12 }}>
                <Text style={styles.kbBarIcon}>⌄</Text>
                <Text style={styles.kbBarText}>完成</Text>
              </TouchableOpacity>
            </View>
          </InputAccessoryView>
        )}
      </>
    );
  };

  const renderKindStage = () => (
    <>
      <View style={styles.headerRow}>
        <Text style={styles.title}>送达方式</Text>
      </View>
      <View style={styles.bodyArea}>
        <View style={styles.sealedLetter}>
          <Text style={styles.sealedLetterText} numberOfLines={3}>
            {content.trim()}
          </Text>
          <View style={styles.sealStamp}>
            <Text style={styles.sealStampText}>已封存</Text>
          </View>
        </View>

        <View style={styles.kindOptions}>
          <TouchableOpacity
            activeOpacity={0.85}
            style={styles.kindCard}
            onPress={() => handlePickKind('mailbox')}
          >
            <Text style={styles.kindEmoji}>📮</Text>
            <Text style={styles.kindTitle}>半日达</Text>
            <Text style={styles.kindSub}>送到本场或下一场，对方很快收到</Text>
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.85}
            style={styles.kindCard}
            onPress={() => handlePickKind('capsule')}
          >
            <Text style={styles.kindEmoji}>💌</Text>
            <Text style={styles.kindTitle}>择日达</Text>
            <Text style={styles.kindSub}>挑一天再送，可以寄给自己或对方</Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={[styles.toolbar, { paddingBottom: insets.bottom + 16 }]}>
        <SpringPressable onPress={() => setStage('write')} style={[styles.pill, styles.pillSecondary]}>
          <Text style={styles.pillSecondaryText}>再改改</Text>
        </SpringPressable>
      </View>
    </>
  );

  const clampedPickDay = useMemo(
    () => Math.min(pickDay, daysInMonth(pickYear, pickMonth)),
    [pickYear, pickMonth, pickDay]
  );
  const previewIso = useMemo(
    () => toUtcIsoFromLocalParts(pickYear, pickMonth, clampedPickDay, pickHour, pickMinute, myTz),
    [pickYear, pickMonth, clampedPickDay, pickHour, pickMinute, myTz]
  );

  const renderCapsuleDetailsStage = () => (
    <>
      <View style={styles.headerRow}>
        <Text style={styles.title}>择日达</Text>
      </View>
      <View style={styles.bodyArea}>
        <Text style={styles.fieldLabel}>什么时候送达？（{friendlyTzName(myTz)}）</Text>
        <View style={styles.dpRow}>
          <TouchableOpacity style={styles.dpField} onPress={() => setDatePart('year')}>
            <Text style={styles.dpLabel}>年</Text>
            <Text style={styles.dpValue}>{pickYear}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.dpField} onPress={() => setDatePart('month')}>
            <Text style={styles.dpLabel}>月</Text>
            <Text style={styles.dpValue}>{pickMonth}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.dpField} onPress={() => setDatePart('day')}>
            <Text style={styles.dpLabel}>日</Text>
            <Text style={styles.dpValue}>{clampedPickDay}</Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.dpRow, styles.dpRowTime]}>
          <TouchableOpacity style={styles.dpField} onPress={() => setDatePart('hour')}>
            <Text style={styles.dpLabel}>时</Text>
            <Text style={styles.dpValue}>{String(pickHour).padStart(2, '0')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.dpField} onPress={() => setDatePart('minute')}>
            <Text style={styles.dpLabel}>分</Text>
            <Text style={styles.dpValue}>{String(pickMinute).padStart(2, '0')}</Text>
          </TouchableOpacity>
        </View>
        {/* Live preview shows the chosen instant rendered in BOTH the
            sender's tz (their picker frame) and the recipient's tz
            (`partnerTz` if known) so the writer can see how their
            partner will read the timestamp. */}
        <View style={styles.previewBlock}>
          <Text style={styles.previewLine}>
            我（{friendlyTzName(myTz)}）：{formatPostmark(previewIso, myTz).split(' ').slice(1).join(' ')}
          </Text>
          <Text style={styles.previewLineMuted}>
            ta 那边收到时：{formatPostmark(previewIso, partnerTz)}
          </Text>
        </View>

        <View style={styles.fieldSpacer} />

        <Text style={styles.fieldLabel}>寄给谁？</Text>
        <View style={styles.recipientRow}>
          <TouchableOpacity
            activeOpacity={0.85}
            style={[styles.recipientCard, recipient === 'self' && styles.recipientCardActive]}
            onPress={() => {
              Haptics.selectionAsync();
              setRecipient('self');
            }}
          >
            <Text style={styles.recipientEmoji}>🪞</Text>
            <Text style={[styles.recipientText, recipient === 'self' && styles.recipientTextActive]}>
              给自己
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.85}
            style={[styles.recipientCard, recipient === 'partner' && styles.recipientCardActive]}
            onPress={() => {
              Haptics.selectionAsync();
              setRecipient('partner');
            }}
          >
            <Text style={styles.recipientEmoji}>💕</Text>
            <Text style={[styles.recipientText, recipient === 'partner' && styles.recipientTextActive]}>
              {partnerName ? `给${partnerName}` : '给对方'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={[styles.toolbar, { paddingBottom: insets.bottom + 16 }]}>
        <SpringPressable onPress={() => setStage('kind')} style={[styles.pill, styles.pillSecondary]}>
          <Text style={styles.pillSecondaryText}>返回</Text>
        </SpringPressable>
        <SpringPressable
          onPress={() => runSubmit('capsule')}
          style={[styles.pill, styles.pillPrimary]}
        >
          <Text style={styles.pillPrimaryText}>投递</Text>
        </SpringPressable>
      </View>
    </>
  );

  // Inline picker for one of {year, month, day, hour, minute}. Mirrors the
  // AnniversaryWishScreen pattern — bottom sheet with a snapping FlatList,
  // tap a value to select. Day pickers reflow as year/month change so 2/30
  // can't be selected.
  const renderDateTimePickerModal = () => {
    if (!datePart) return null;
    let data: number[] = [];
    let unit = '';
    if (datePart === 'year') {
      const cur = new Date().getFullYear();
      // 6-year window: this year + next 5
      data = Array.from({ length: 6 }, (_, i) => cur + i);
      unit = '年';
    } else if (datePart === 'month') {
      data = Array.from({ length: 12 }, (_, i) => i + 1);
      unit = '月';
    } else if (datePart === 'day') {
      data = Array.from({ length: daysInMonth(pickYear, pickMonth) }, (_, i) => i + 1);
      unit = '日';
    } else if (datePart === 'hour') {
      data = Array.from({ length: 24 }, (_, i) => i);
      unit = '时';
    } else {
      data = Array.from({ length: 60 }, (_, i) => i);
      unit = '分';
    }

    const current = datePart === 'year' ? pickYear
      : datePart === 'month' ? pickMonth
      : datePart === 'day' ? clampedPickDay
      : datePart === 'hour' ? pickHour
      : pickMinute;
    const initialIndex = Math.max(0, data.indexOf(current));
    const titleText = datePart === 'year' ? '选择年份'
      : datePart === 'month' ? '选择月份'
      : datePart === 'day' ? '选择日'
      : datePart === 'hour' ? '选择小时'
      : '选择分钟';

    return (
      <Modal visible animationType="slide" transparent onRequestClose={() => setDatePart(null)}>
        <View style={styles.pickerOverlay}>
          <View style={[styles.pickerSheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>{titleText}</Text>
              <TouchableOpacity onPress={() => setDatePart(null)}>
                <Text style={styles.pickerClose}>完成</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={data}
              keyExtractor={item => String(item)}
              initialScrollIndex={initialIndex}
              getItemLayout={(_, index) => ({ length: 52, offset: 52 * index, index })}
              renderItem={({ item }) => {
                const active = item === current;
                return (
                  <TouchableOpacity
                    style={[styles.pickerItem, active && styles.pickerItemActive]}
                    onPress={() => {
                      Haptics.selectionAsync();
                      if (datePart === 'year') {
                        setPickYear(item);
                        setPickDay(d => Math.min(d, daysInMonth(item, pickMonth)));
                      } else if (datePart === 'month') {
                        setPickMonth(item);
                        setPickDay(d => Math.min(d, daysInMonth(pickYear, item)));
                      } else if (datePart === 'day') {
                        setPickDay(item);
                      } else if (datePart === 'hour') {
                        setPickHour(item);
                      } else {
                        setPickMinute(item);
                      }
                      setDatePart(null);
                    }}
                  >
                    <Text style={[styles.pickerItemText, active && styles.pickerItemTextActive]}>
                      {datePart === 'hour' || datePart === 'minute'
                        ? String(item).padStart(2, '0') + unit
                        : `${item}${unit}`}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    );
  };

  const renderSendingStage = () => {
    const rotateInterp = letterRotate.interpolate({
      inputRange: [-360, 360],
      outputRange: ['-360deg', '360deg'],
    });
    const mailboxScale = mailboxBounce.interpolate({
      inputRange: [0, 0.5, 1],
      outputRange: [1, 1.18, 1],
    });
    return (
      <View style={styles.sendingArea}>
        <Animated.View
          style={[
            styles.flyingLetter,
            {
              opacity: letterOpacity,
              transform: [
                { translateY: letterY },
                { scale: letterScale },
                { rotate: rotateInterp },
              ],
            },
          ]}
        >
          <Text style={styles.flyingLetterText} numberOfLines={2}>
            {content.trim()}
          </Text>
        </Animated.View>
        <Animated.Text
          style={[styles.mailboxIcon, { transform: [{ scale: mailboxScale }] }]}
        >
          📮
        </Animated.Text>
        <Text style={styles.sendingHint}>{submitted ? '已寄出 ✓' : '寄出中...'}</Text>
      </View>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleCancel}
    >
      {/* KeyboardAvoidingView shrinks the modal's content area by the
          keyboard's height when it's up. With container as flex:1 inside
          and bodyArea as flex:1 inside that, the letterPaper + TextInput
          + bottom toolbar all compress above the keyboard — the user can
          see what they're typing AND reach the 去寄出 pill without doing
          anything. iOS's native multiline TextInput cursor-tracking then
          handles scrolling within the (now smaller) input as the user
          types past the visible area.

          Only iOS uses 'padding' here; Android handles soft keyboard via
          android:windowSoftInputMode at the activity level, KAV would
          double-shift. The app is iOS-first, but the `undefined` fallback
          keeps things sane if ever ported. */}
      <KeyboardAvoidingView
        style={styles.kavRoot}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.container}>
          {stage === 'write' && renderWriteStage()}
          {stage === 'sealing' && (
            <>
              <View style={styles.headerRow}>
                <Text style={styles.title}>封信</Text>
              </View>
              <View style={styles.bodyArea}>
                <SealAnimation
                  preview={content.trim()}
                  onComplete={() => {
                    if (mountedRef.current) setStage('kind');
                  }}
                />
              </View>
            </>
          )}
          {stage === 'kind' && renderKindStage()}
          {stage === 'capsuleDetails' && renderCapsuleDetailsStage()}
          {stage === 'sending' && renderSendingStage()}
          {renderDateTimePickerModal()}
          {/* Top-of-modal pill for "信已寄出" confirmation. Anchored above
              the safe area so it visually mimics iOS Dynamic Island. The
              modal closes ~700ms after `show()`, mid-fade-out, so the
              user sees the toast appear and dissolve smoothly. */}
          <IslandToast ref={toastRef} top={insets.top + 8} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const PAPER = '#FAF6E8';
const INK = '#3D2A19';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  kavRoot: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  headerRow: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 14,
    paddingBottom: 10,
    minHeight: 40,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.text,
  },
  bodyArea: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 16,
  },

  // ── Letter paper (write stage) ─────────────────────────────────────────
  letterPaper: {
    flex: 1,
    backgroundColor: PAPER,
    borderRadius: 4,
    paddingHorizontal: LETTER_PAPER_PAD,
    paddingTop: 20,
    paddingBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 1, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
  // Salutation at the top of the page — "致 X：". Keeps the formal letter
  // shape; the address is filled in from the user's data, not editable.
  letterAddress: {
    fontSize: 16,
    fontWeight: '600',
    color: INK,
    marginBottom: 14,
    fontStyle: 'italic',
  },
  letterBody: {
    flex: 1,
    fontSize: 16,
    lineHeight: 26,
    color: INK,
    textAlignVertical: 'top',
    fontStyle: 'italic',
    fontWeight: '500',
  },
  // Footer block with time + signature + char count. Right-aligned to
  // match traditional letter-bottom signatures.
  letterFooter: {
    alignItems: 'flex-end',
    marginTop: 10,
    gap: 2,
  },
  letterFooterTime: {
    fontSize: 12,
    color: '#8B7355',
    fontVariant: ['tabular-nums'],
    fontStyle: 'italic',
  },
  letterFooterSig: {
    fontSize: 14,
    color: INK,
    fontStyle: 'italic',
    fontWeight: '500',
    marginTop: 2,
  },
  letterCount: {
    fontSize: 11,
    color: '#8B7355',
    marginTop: 4,
  },

  // ── iOS keyboard accessory bar ─────────────────────────────────────────
  kbBar: {
    backgroundColor: '#F2F2F7',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.18)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'flex-end',
  },
  kbBarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  kbBarIcon: {
    fontSize: 18,
    color: '#0A84FF',
    lineHeight: 20,
  },
  kbBarText: {
    fontSize: 15,
    color: '#0A84FF',
    fontWeight: '500',
  },

  // ── Sealed letter card (kind stage preview) ────────────────────────────
  sealedLetter: {
    backgroundColor: PAPER,
    borderRadius: 6,
    paddingHorizontal: 20,
    paddingVertical: 18,
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 1, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 4,
  },
  sealedLetterText: {
    fontSize: 14,
    lineHeight: 22,
    color: INK,
    fontStyle: 'italic',
  },
  sealStamp: {
    position: 'absolute',
    top: -10,
    right: -8,
    backgroundColor: '#A02020',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    transform: [{ rotate: '-8deg' }],
  },
  sealStampText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },

  // ── Kind picker ────────────────────────────────────────────────────────
  kindOptions: {
    gap: 14,
  },
  kindCard: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    paddingVertical: 22,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  kindEmoji: {
    fontSize: 36,
    marginBottom: 6,
  },
  kindTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 4,
  },
  kindSub: {
    fontSize: 12,
    color: COLORS.textLight,
    textAlign: 'center',
  },

  // ── Capsule details (date + recipient) ─────────────────────────────────
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textLight,
    marginBottom: 10,
  },
  fieldSpacer: {
    height: 24,
  },
  // 5-field datetime picker — 3 fields for date (年/月/日) + 2 for time
  // (时/分). Each field opens a bottom-sheet FlatList.
  dpRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  dpRowTime: {
    marginTop: 10,
  },
  dpField: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  dpLabel: {
    fontSize: 11,
    color: COLORS.textLight,
    marginBottom: 2,
  },
  dpValue: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
    fontVariant: ['tabular-nums'],
  },
  // Live preview of the picked instant in both timezones — gives the
  // sender immediate feedback on how the recipient will see it.
  previewBlock: {
    marginTop: 12,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 4,
  },
  previewLine: {
    fontSize: 13,
    color: COLORS.text,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  previewLineMuted: {
    fontSize: 12,
    color: COLORS.textLight,
    fontVariant: ['tabular-nums'],
  },
  // Bottom-sheet picker overlay — same visual language as
  // AnniversaryWishScreen's date picker, kept consistent across the app.
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
  },
  pickerClose: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.kiss,
  },
  pickerItem: {
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  pickerItemActive: {
    backgroundColor: '#FFF0F3',
  },
  pickerItemText: {
    fontSize: 16,
    color: COLORS.text,
    fontVariant: ['tabular-nums'],
  },
  pickerItemTextActive: {
    color: COLORS.kiss,
    fontWeight: '700',
  },
  recipientRow: {
    flexDirection: 'row',
    gap: 12,
  },
  recipientCard: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 14,
    paddingVertical: 18,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  recipientCardActive: {
    borderColor: COLORS.kiss,
    backgroundColor: '#FFF0F3',
  },
  recipientEmoji: {
    fontSize: 24,
    marginBottom: 4,
  },
  recipientText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textLight,
  },
  recipientTextActive: {
    color: COLORS.kiss,
  },

  // ── Sending animation ──────────────────────────────────────────────────
  sendingArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 80,
  },
  flyingLetter: {
    backgroundColor: PAPER,
    paddingHorizontal: 22,
    paddingVertical: 16,
    borderRadius: 4,
    width: 220,
    minHeight: 100,
    shadowColor: '#000',
    shadowOffset: { width: 1, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 6,
  },
  flyingLetterText: {
    fontSize: 14,
    lineHeight: 22,
    color: INK,
    fontStyle: 'italic',
  },
  mailboxIcon: {
    fontSize: 80,
    marginTop: 60,
  },
  sendingHint: {
    marginTop: 20,
    fontSize: 13,
    color: COLORS.textLight,
  },

  // ── Toolbar ────────────────────────────────────────────────────────────
  toolbar: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    paddingTop: 12,
  },
  pill: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 8,
    minWidth: 110,
    alignItems: 'center',
  },
  pillPrimary: {
    backgroundColor: COLORS.kiss,
  },
  pillSecondary: {
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  pillPrimaryText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  pillSecondaryText: {
    color: COLORS.textLight,
    fontSize: 15,
    fontWeight: '600',
  },
});
