import React, { useEffect, useState, useCallback, useRef, useMemo, forwardRef, useImperativeHandle } from 'react';
import {
  Modal,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Dimensions,
  Easing,
  Pressable,
} from 'react-native';
import { SpringPressable } from '../components/SpringPressable';

const SCREEN_H = Dimensions.get('window').height;
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../constants';
import { api, CapsuleItem } from '../services/api';
import { storage } from '../utils/storage';
import { mailboxRevealTime, normalizeIso } from '../utils/inboxUnread';
import { formatPostmark } from '../utils/postmark';
import EnvelopeOpenAnimation from '../components/EnvelopeOpenAnimation';
import IslandToast, { IslandToastHandle } from '../components/IslandToast';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export interface InboxHandle {
  reload: () => Promise<void>;
}

type LetterKind = 'mailbox' | 'capsule';

interface LetterCard {
  key: string;
  kind: LetterKind;
  refId: number;
  // ISO timestamp the letter "arrived" (mailbox: reveal time of the
  // session; capsule: opened_at). Used for sort + unread comparison.
  arrivedAt: string;
  // ISO timestamp the letter was WRITTEN (mailbox: partner_created_at,
  // capsule: created_at). Used as the secondary sort key so multiple
  // mailbox letters in the same session display in write-chronological
  // order — newer write goes to the bottom (= more visible on open).
  writtenAt: string;
  // Two postmark lines, formatted in their respective timezones.
  //   writtenStamp = "写于 [partner tz time when ta wrote it]"
  //   receivedStamp = "收于 [my tz time when it arrived in my inbox]"
  writtenStamp: string;
  receivedStamp: string;
  from: string;
  to: string;
  body: string;
  kindLabel: string;
  accent: string;
}

const MAILBOX_ACCENT = '#FFB5C2';
const CAPSULE_ACCENT = '#C3AED6';
const SCREEN_W = Dimensions.get('window').width;

// Layout interval — drives snapping. Cards lay out at i*SNAP_INTERVAL apart.
//
// CARD_HEIGHT clamps to [220, 280] from screen height. Floor at 220 so
// content (kind row + 2 stamp lines + divider + sender row + 3 snippet
// lines + footer + 36pt vertical padding ≈ 200pt) never gets clipped
// on small screens. Ceiling at 280 keeps the card from looking absurd
// on iPad-sized viewports. In between, scales as 28% of viewport height
// so SE / Pro Max / iPad each feel proportionally consistent.
const CARD_HEIGHT = Math.max(220, Math.min(280, Math.round(SCREEN_H * 0.28)));
const CARD_GAP = 16;
const SNAP_INTERVAL = CARD_HEIGHT + CARD_GAP;

// Visual stacking offset — peek cards expose 25% of card height, so
// each card overlaps the previous by 75% regardless of CARD_HEIGHT.
const STACK_OFFSET = Math.round(CARD_HEIGHT * 0.25);

// Right-swipe threshold to trigger deletion (~38% of screen width).
const SWIPE_THRESHOLD = SCREEN_W * 0.38;

const InboxScreen = forwardRef<InboxHandle, Props>(({ visible, onClose }, ref) => {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState<LetterCard[]>([]);
  const [revealAnim, setRevealAnim] = useState<LetterCard | null>(null);
  // Seed listHeight with a screen-height-derived guess so verticalPad has a
  // sensible value during the pageSheet slide-in (when onLayout sometimes
  // hasn't fired yet). The real measurement replaces this on first layout
  // pass. This is what was causing "cards don't paint until I scroll" — the
  // ScrollView's native-driven transforms had no real layout context at
  // mount, leaving cards stuck at uncomputed positions until a finger drag
  // forced a re-layout.
  const [listHeight, setListHeight] = useState(SCREEN_H * 0.7);
  // Captured from the header's onLayout so the title-edge gradient sits
  // EXACTLY at the header's bottom edge (no visible gap between title
  // bar and fade). Default 64 is a sensible pre-layout fallback.
  const [headerBottomY, setHeaderBottomY] = useState(64);
  const [centerIdx, setCenterIdx] = useState(0);
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollViewRef = useRef<ScrollView>(null);
  const toastRef = useRef<IslandToastHandle>(null);
  // Track focused index in a ref so the per-card haptic tick is independent
  // of React's state-update batching during fast scrolls (state can lag and
  // miss transitions; the ref is updated synchronously inside the listener).
  const lastTickedIdxRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const [myName, partnerRemark, partnerName, myTz, partnerTz, mailbox, capsules] = await Promise.all([
        storage.getUserName(),
        storage.getPartnerRemark(),
        storage.getPartnerName(),
        storage.getTimezone(),
        storage.getPartnerTimezone(),
        api.getMailboxArchive(50).catch(() => ({ weeks: [] })),
        api.getCapsules().catch(() => ({ capsules: [] as CapsuleItem[] })),
      ]);
      const me = myName || '我';
      const ta = (partnerRemark && partnerRemark.trim()) || partnerName || 'ta';
      const myZone = myTz || 'Asia/Shanghai';
      const partnerZone = partnerTz || 'Asia/Shanghai';

      const out: LetterCard[] = [];

      for (const w of mailbox.weeks || []) {
        if (!w.partner_content || !w.partner_message_id) continue;
        const arrivedAt = mailboxRevealTime(w.week_key);
        // Server returns ISO of when the partner submitted; fall back to
        // reveal time if missing (e.g. legacy rows without created_at).
        const writtenAt = normalizeIso(w.partner_created_at) || arrivedAt;
        out.push({
          key: `m-${w.partner_message_id}`,
          kind: 'mailbox',
          refId: w.partner_message_id,
          arrivedAt,
          writtenAt,
          // 写于: ta's wall-clock when they hit send (partner tz)
          writtenStamp: `写于 ${formatPostmark(writtenAt, partnerZone)}`,
          // 收于: my wall-clock when the letter was revealed in my inbox
          // (= session reveal time, in my tz)
          receivedStamp: `收于 ${formatPostmark(arrivedAt, myZone)}`,
          from: ta,
          to: me,
          body: w.partner_content,
          kindLabel: '半日达 · 来自 ta',
          accent: MAILBOX_ACCENT,
        });
      }

      for (const c of capsules.capsules || []) {
        if (!c.opened_at || !c.content) continue;
        if (c.author === 'me' && c.visibility === 'partner') continue;

        let from = me;
        let to = ta;
        let kindLabel = '择日达';
        let writerZone = myZone;
        if (c.author === 'me' && c.visibility === 'self') {
          from = me; to = me;
          kindLabel = '择日达 · 给自己';
          writerZone = myZone;
        } else if (c.author === 'partner') {
          from = ta; to = me;
          kindLabel = '择日达 · 来自 ta';
          writerZone = partnerZone;
        }
        const capsuleArrived = normalizeIso(c.opened_at);
        const writtenIso = normalizeIso(c.created_at);
        out.push({
          key: `c-${c.id}`,
          kind: 'capsule',
          refId: c.id,
          arrivedAt: capsuleArrived,
          writtenAt: writtenIso,
          // For self-vis capsules the "ta" is also me, so 写于 still uses
          // writerZone (which equals myZone in that case).
          writtenStamp: `写于 ${formatPostmark(writtenIso, writerZone)}`,
          receivedStamp: `收于 ${formatPostmark(capsuleArrived, myZone)}`,
          from,
          to,
          body: c.content,
          kindLabel,
          accent: CAPSULE_ACCENT,
        });
      }

      // Oldest first → newest last. The user enters at the bottom (see the
      // scroll-to-latest effect below), so this matches "scroll up to read
      // older letters".
      //
      // Primary key: arrivedAt ASC (older arrival earlier in the array).
      // Secondary key: writtenAt ASC — for letters that arrived together
      // (same mailbox session reveal), the LATER-written one ends up
      // closer to the bottom, so it's the first thing the user sees on
      // open. Sort is stable, so equal pairs preserve insert order.
      out.sort((a, b) => {
        if (a.arrivedAt < b.arrivedAt) return -1;
        if (a.arrivedAt > b.arrivedAt) return 1;
        if (a.writtenAt < b.writtenAt) return -1;
        if (a.writtenAt > b.writtenAt) return 1;
        return 0;
      });
      setCards(out);
      // Don't reset centerIdx on background refreshes — user may have
      // scrolled. Only reset when list shape clearly changed.
    } finally {
      setLoading(false);
    }
  }, []);

  useImperativeHandle(ref, () => ({ reload: load }), [load]);

  // Captured-then-advanced inbox-last-seen marker. Comparing each card's
  // arrivedAt against the captured (pre-open) value tells us which letters
  // arrived since the last visit. We advance the stored marker to "now"
  // immediately on open, so re-opening within the same session shows fewer
  // unread (i.e. once you've seen them, they're seen).
  const seenBeforeOpenRef = useRef<string>('');
  // Read cards.length via ref so the open effect doesn't re-fire on every
  // background reload (which would defeat the stale-while-revalidate cache).
  const cardsLengthRef = useRef(0);
  cardsLengthRef.current = cards.length;
  useEffect(() => {
    if (!visible) return;
    // Only show spinner if we have nothing cached. Re-opens with stale
    // cards in memory render instantly + refresh in the background. Drops
    // the previously-noticeable open delay.
    if (cardsLengthRef.current === 0) setLoading(true);
    // Resolve the seen marker BEFORE kicking off load() so cards never paint
    // with an empty seenBeforeOpenRef — otherwise every card briefly flashes
    // the "未读" pill until AsyncStorage resolves a few ms later.
    (async () => {
      const { seen_at } = await api.getInboxSeen().catch(() => ({ seen_at: null as string | null }));
      // First-ever open: anchor at "now" so we don't flag every historical
      // letter as unread on first launch. After this call, only NEW arrivals
      // (between visits) get the badge.
      seenBeforeOpenRef.current = seen_at ?? new Date().toISOString();
      api.markInboxSeen().catch(() => {});
      load();
    })();
  }, [visible, load]);

  const verticalPad = Math.max(0, (listHeight - CARD_HEIGHT) / 2);

  // Land the user on the latest letter (bottom) on first paint. Doing the
  // scroll programmatically also kicks the natively-driven scrollY chain
  // awake — without this nudge, the cards' interpolated transforms can sit
  // un-bridged after the pageSheet slide-in, producing "blank inbox until
  // you swipe" symptoms. Re-runs only when card count changes (i.e. fresh
  // open or reload that adds a letter), not on background refreshes that
  // keep the same shape.
  const initialScrolledRef = useRef(false);
  useEffect(() => {
    if (!visible) {
      initialScrolledRef.current = false;
      return;
    }
    if (loading || cards.length === 0 || initialScrolledRef.current) return;
    const targetIdx = cards.length - 1;
    const targetY = targetIdx * SNAP_INTERVAL;
    // Native value first so transforms recompute, then ScrollView frame
    // catches up.
    scrollY.setValue(targetY);
    requestAnimationFrame(() => {
      scrollViewRef.current?.scrollTo({ y: targetY, animated: false });
      setCenterIdx(targetIdx);
      lastTickedIdxRef.current = targetIdx;
      initialScrolledRef.current = true;
    });
  }, [visible, loading, cards.length, scrollY]);

  const onScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    {
      useNativeDriver: true,
      listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const idx = Math.round(e.nativeEvent.contentOffset.y / SNAP_INTERVAL);
        const clamped = Math.max(0, Math.min(cards.length - 1, idx));
        if (clamped !== lastTickedIdxRef.current) {
          // Picker-style click tick as each letter passes the focus position.
          Haptics.selectionAsync();
          lastTickedIdxRef.current = clamped;
          setCenterIdx(clamped);
        }
      },
    }
  );

  const handleCardPress = (index: number, card: LetterCard) => {
    if (index === centerIdx) {
      setRevealAnim(card);
    } else {
      scrollViewRef.current?.scrollTo({ y: index * SNAP_INTERVAL, animated: true });
    }
  };

  const handleSwipeOut = useCallback(async (card: LetterCard) => {
    // Optimistic removal — remove from local state immediately, fire API.
    // If the API fails, reload from server to restore the truth.
    setCards(prev => prev.filter(c => c.key !== card.key));
    toastRef.current?.show('已移到垃圾篓 · 可在垃圾篓恢复');
    try {
      await api.trashInboxItem(card.kind, card.refId);
    } catch {
      toastRef.current?.show('移到垃圾篓失败');
      load();
    }
  }, [load]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
    >
      <View style={[styles.container, { paddingTop: 24 }]}>
        <View
          style={styles.header}
          onLayout={(e) => {
            // y is relative to the container's padding box; padding is
            // 24, so y here is 24. Adding height yields the header's
            // absolute bottom edge — used to anchor the title-edge fade
            // so the gradient touches the title bar with no gap.
            const { y, height } = e.nativeEvent.layout;
            setHeaderBottomY(y + height);
          }}
        >
          <Text style={styles.headerTitle}>📬 收件箱</Text>
        </View>

        {/* Tap on the list background (anywhere not on a card or interactive
            child) closes the inbox. ScrollView claims drag motions for itself
            so vertical scrolls still work; taps on padding bubble up to this
            Pressable. Card TouchableOpacity / SpringPressable on the pill
            still capture their own presses without triggering close. */}
        <Pressable
          style={styles.listWrap}
          onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}
          onPress={onClose}
        >
          {loading ? (
            <View style={styles.centered}>
              <ActivityIndicator color={COLORS.kiss} />
            </View>
          ) : cards.length === 0 ? (
            <View style={styles.centered}>
              <Text style={styles.emptyEmoji}>💌</Text>
              <Text style={styles.emptyTitle}>还没有收到信</Text>
              <Text style={styles.emptySub}>已送达的半日达和已开启的择日达都会出现在这里</Text>
            </View>
          ) : (
            // Render unconditionally — gating on listHeight > 0 stalled the
            // first paint when onLayout hadn't fired yet (pageSheet animation
            // sometimes defers it), and the user only saw the cards after
            // touching the screen forced a re-layout. verticalPad falls back
            // to 0 while listHeight is still being measured; the cards
            // re-center the moment onLayout reports the real height.
            <Animated.ScrollView
              ref={scrollViewRef as any}
              contentContainerStyle={[
                styles.stackContainer,
                { paddingTop: verticalPad, paddingBottom: verticalPad },
              ]}
              showsVerticalScrollIndicator={false}
              snapToInterval={SNAP_INTERVAL}
              // "normal" decel + snap = flicks travel further before snapping
              // (was "fast", which braked too aggressively — light flicks
              // could only cross 2-3 cards). With normal deceleration and
              // snapToInterval still in place, the user can browse 5-10+
              // cards per flick while still landing on a clean card boundary.
              decelerationRate="normal"
              onScroll={onScroll}
              scrollEventThrottle={16}
            >
              {cards.map((card, index) => {
                const cardScrollAtCenter = index * SNAP_INTERVAL;
                const translateY = scrollY.interpolate({
                  inputRange: [
                    cardScrollAtCenter - SNAP_INTERVAL,
                    cardScrollAtCenter,
                    cardScrollAtCenter + SNAP_INTERVAL,
                  ],
                  outputRange: [
                    STACK_OFFSET - SNAP_INTERVAL,
                    0,
                    SNAP_INTERVAL - STACK_OFFSET,
                  ],
                  extrapolate: 'extend',
                });
                const scale = scrollY.interpolate({
                  inputRange: [
                    cardScrollAtCenter - 2 * SNAP_INTERVAL,
                    cardScrollAtCenter - SNAP_INTERVAL,
                    cardScrollAtCenter,
                    cardScrollAtCenter + SNAP_INTERVAL,
                    cardScrollAtCenter + 2 * SNAP_INTERVAL,
                  ],
                  outputRange: [0.86, 0.93, 1, 0.93, 0.86],
                  extrapolate: 'clamp',
                });

                const dist = Math.abs(index - centerIdx);
                const zIdx = cards.length - dist;

                return (
                  <Animated.View
                    key={card.key}
                    style={[
                      styles.cardSlot,
                      index === cards.length - 1 ? null : { marginBottom: CARD_GAP },
                      {
                        zIndex: zIdx,
                        elevation: zIdx,
                        transform: [{ translateY }, { scale }],
                      },
                    ]}
                  >
                    <SwipeableCard
                      enabled={index === centerIdx}
                      onSwipeOut={() => handleSwipeOut(card)}
                    >
                      <TouchableOpacity
                        activeOpacity={0.85}
                        onPress={() => handleCardPress(index, card)}
                        style={[styles.card, { backgroundColor: card.accent }]}
                      >
                        <View style={styles.cardHeader}>
                          <View style={styles.cardKindRow}>
                            <Text style={styles.cardKind}>{card.kindLabel}</Text>
                            {card.arrivedAt > seenBeforeOpenRef.current && (
                              <View style={styles.unreadPill}>
                                <Text style={styles.unreadPillText}>未读</Text>
                              </View>
                            )}
                          </View>
                          {/* Two-line postmark with the actual semantic
                              moments in their respective timezones:
                              first line = when ta wrote it (their tz),
                              second line = when it landed in my inbox
                              (my tz). The recipient gets both halves of
                              the journey without doing tz math. */}
                          <View style={styles.cardStampStack}>
                            <Text style={styles.cardStampLine}>
                              {card.writtenStamp}
                            </Text>
                            <Text style={styles.cardStampLine}>
                              {card.receivedStamp}
                            </Text>
                          </View>
                        </View>
                        <View style={styles.cardDivider} />
                        <View style={styles.cardFromTo}>
                          <Text style={styles.cardFromToText} numberOfLines={1}>
                            {card.from} → {card.to}
                          </Text>
                        </View>
                        <View style={styles.cardSnippetWrap}>
                          <Text style={styles.cardSnippet} numberOfLines={3}>
                            {card.body}
                          </Text>
                        </View>
                        <View style={styles.cardFooter}>
                          <Text style={styles.cardCta}>
                            {index === centerIdx ? '轻点开启 · 右划删除' : '轻点居中'}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    </SwipeableCard>
                  </Animated.View>
                );
              })}
            </Animated.ScrollView>
          )}
        </Pressable>

        {/* Title-edge soft fade — pinned to the header's measured bottom
            edge (via onLayout above) so the solid first stop seamlessly
            extends the title bar, then dissolves to transparent over
            the next 56pt. Cards sliding up disappear gradually instead
            of meeting a hard cut. */}
        <LinearGradient
          colors={[
            COLORS.background,
            COLORS.background,
            'rgba(255, 245, 245, 0.6)',
            'rgba(255, 245, 245, 0.2)',
            'rgba(255, 245, 245, 0)',
          ]}
          locations={[0, 0.2, 0.55, 0.85, 1]}
          pointerEvents="none"
          style={[styles.titleEdgeFade, { top: headerBottomY }]}
        />

        {/* "收起" 灵动岛 pill — primary close affordance, anchored to the bottom
            center of the modal. Mirrors the StickyWallScreen toolbar pattern. */}
        <View style={[styles.pillSlot, { paddingBottom: insets.bottom + 16 }]} pointerEvents="box-none">
          <SpringPressable onPress={onClose} style={styles.dismissPill} scaleTo={1.06}>
            <Text style={styles.dismissPillText}>收起</Text>
          </SpringPressable>
        </View>

        {/* v1.3.8 — wrapInModal=true (default). Letter overlay rides on its
            own transparent (overFullScreen on iOS) Modal stacked above the
            InboxScreen pageSheet. The previous `wrapInModal={false}` was a
            sibling absoluteFill inside this pageSheet, which let iOS's
            native pageSheet swipe-to-dismiss recognizer see vertical drags
            in the letter area — when the inner ScrollView reached its top
            and the user kept dragging down, the dismiss recognizer took
            over and the whole inbox slid with the finger. The nested
            overFullScreen modal blocks all touches from ever reaching the
            pageSheet's recognizer, so the letter ScrollView is fully
            self-contained. */}
        <EnvelopeOpenAnimation
          visible={!!revealAnim}
          skipEnvelope
          kindLabel={revealAnim?.kindLabel}
          from={revealAnim?.from}
          to={revealAnim?.to}
          date={revealAnim?.writtenStamp}
          content={revealAnim?.body ?? ''}
          onClose={() => setRevealAnim(null)}
        />

        <IslandToast ref={toastRef} top={insets.top + 8} />
      </View>
    </Modal>
  );
});

export default InboxScreen;

// Wraps a card with a horizontal pan gesture that swipes the card off to the
// right when released past SWIPE_THRESHOLD. Vertical motion is yielded to the
// ScrollView. Only enabled for the centered card so peek cards can't be
// accidentally dismissed.
function SwipeableCard({
  children,
  onSwipeOut,
  enabled,
}: {
  children: React.ReactNode;
  onSwipeOut: () => void;
  enabled: boolean;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => {
          if (!enabled) return false;
          // Claim the gesture only when horizontal motion clearly dominates,
          // so vertical scrolling stays with the parent ScrollView.
          return Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6;
        },
        onMoveShouldSetPanResponderCapture: (_, g) => {
          if (!enabled) return false;
          return Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 2.2;
        },
        onPanResponderMove: (_, g) => {
          // Only follow rightward swipes; clamp leftward motion at 0.
          translateX.setValue(Math.max(0, g.dx));
          // Slight opacity falloff as the card moves away.
          opacity.setValue(Math.max(0.4, 1 - g.dx / SCREEN_W));
        },
        onPanResponderRelease: (_, g) => {
          if (g.dx >= SWIPE_THRESHOLD) {
            Animated.parallel([
              Animated.timing(translateX, {
                toValue: SCREEN_W * 1.1,
                duration: 220,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
              }),
              Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
            ]).start(() => onSwipeOut());
          } else {
            Animated.parallel([
              Animated.spring(translateX, { toValue: 0, friction: 7, tension: 70, useNativeDriver: true }),
              Animated.spring(opacity, { toValue: 1, friction: 7, useNativeDriver: true }),
            ]).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.parallel([
            Animated.spring(translateX, { toValue: 0, friction: 7, tension: 70, useNativeDriver: true }),
            Animated.spring(opacity, { toValue: 1, friction: 7, useNativeDriver: true }),
          ]).start();
        },
      }),
    [enabled, onSwipeOut, translateX, opacity]
  );

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[styles.swipeWrap, { transform: [{ translateX }], opacity }]}
    >
      {children}
    </Animated.View>
  );
}

// formatPostmark + TZ_FRIENDLY moved to ../utils/postmark — shared with
// WriteLetterScreen (footer signature) so receiver-side stamps and writer-
// side stamps stay locked to the same format.

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  // Title sits high in the modal (paddingTop on the container is small) and
  // is horizontally centered. The 完成 button used to live here but moved to
  // a "收起" pill at the bottom center, so the header is title-only now.
  header: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingBottom: 12,
    minHeight: 32,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.text,
    textAlign: 'center',
  },
  // top is set dynamically from the header's onLayout-measured bottom
  // edge so the gradient seamlessly continues the title bar, regardless
  // of how RN renders the title text height on this device. Height 56
  // gives a long, gentle dissolve over which cards softly disappear.
  titleEdgeFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 56,
  },
  // Bottom-center "收起" pill toolbar (灵动岛 styling).
  pillSlot: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
  },
  dismissPill: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: COLORS.kiss,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 8,
    minWidth: 132,
    alignItems: 'center',
  },
  dismissPillText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  listWrap: {
    flex: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: COLORS.text, marginBottom: 6 },
  emptySub: { fontSize: 13, color: COLORS.textLight, textAlign: 'center', lineHeight: 19 },
  stackContainer: {
    paddingHorizontal: 16,
  },
  cardSlot: {
    height: CARD_HEIGHT,
  },
  swipeWrap: {
    flex: 1,
  },
  card: {
    flex: 1,
    borderRadius: 18,
    paddingHorizontal: 20,
    paddingVertical: 18,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    justifyContent: 'space-between',
    // Subtle inner stroke gives the card the feel of an actual letter card
    // — quiet but a touch more "formal" without overhauling the look.
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardKindRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardKind: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.white,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  unreadPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.95)',
  },
  unreadPillText: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.kiss,
    letterSpacing: 0.4,
  },
  cardDate: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
    fontVariant: ['tabular-nums'],
  },
  cardStampStack: {
    alignItems: 'flex-end',
    gap: 2,
  },
  cardStampLine: {
    fontSize: 10.5,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
    fontVariant: ['tabular-nums'],
  },
  cardDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.4)',
    marginTop: 10,
    marginBottom: 6,
  },
  cardFromTo: {
    marginTop: 4,
  },
  cardFromToText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.white,
  },
  cardSnippetWrap: {
    flex: 1,
    justifyContent: 'center',
    paddingTop: 4,
  },
  cardSnippet: {
    fontSize: 14,
    lineHeight: 21,
    color: 'rgba(255,255,255,0.97)',
  },
  cardFooter: {
    alignItems: 'flex-end',
  },
  cardCta: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.9)',
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
