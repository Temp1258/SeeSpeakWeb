import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { View, ScrollView, Text, TouchableOpacity, StyleSheet, RefreshControl, Animated, AppState as RNAppState, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../constants';
import InboxScreen, { InboxHandle } from './InboxScreen';
import OutboxScreen, { OutboxHandle } from './OutboxScreen';
import TrashScreen, { TrashHandle } from './TrashScreen';
import StickyWallScreen, { StickyWallHandle } from './StickyWallScreen';
import SnapCalendarScreen, { SnapCalendarHandle } from './SnapCalendarScreen';
import WriteLetterScreen from './WriteLetterScreen';
import { hasUnreadInboxItems, hasFreshOutboxItems } from '../utils/inboxUnread';
import { api } from '../services/api';
import { subscribe } from '../services/socket';
import { storage } from '../utils/storage';
import { subscribeOutboxChanged } from '../utils/outboxEvents';
import { SpringPressable } from '../components/SpringPressable';
import { useNextHalfDayRevealAt } from '../utils/countdown';
import { formatPostmark } from '../utils/postmark';

export default function MailboxScreen() {
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  // PillTabBar's height is computed in App.tsx as roughly
  //   pillH (= width * 0.14) + paddingTop (width * 0.02) + paddingBottom
  //   (insets.bottom + width * 0.015)
  // ≈ width * 0.175 + insets.bottom. The 写信 pill sits 16pt above
  // that — proportional to screen so visual gap stays consistent across
  // SE / standard / Pro Max instead of being a hardcoded "+96 from
  // insets.bottom" estimate that drifted on different device widths.
  const writePillBottom = insets.bottom + Math.round(screenW * 0.175) + 16;
  const [refreshing, setRefreshing] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [stickyOpen, setStickyOpen] = useState(false);
  const [snapCalendarOpen, setSnapCalendarOpen] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const [inboxHasUnread, setInboxHasUnread] = useState(false);
  const [outboxHasFresh, setOutboxHasFresh] = useState(false);
  const [stickyHasUnread, setStickyHasUnread] = useState(false);
  const [partnerName, setPartnerName] = useState<string>('');
  const [myTz, setMyTz] = useState('Asia/Shanghai');
  const inboxRef = useRef<InboxHandle>(null);
  const outboxRef = useRef<OutboxHandle>(null);
  const trashRef = useRef<TrashHandle>(null);
  const stickyRef = useRef<StickyWallHandle>(null);
  const snapCalendarRef = useRef<SnapCalendarHandle>(null);

  // Next 半日达 delivery boundary (8am / 8pm BJT, one every 12h) rendered
  // in the user's preferred tz — same shape as the daily refresh hint on
  // the 每日 tab so the visual language stays consistent across screens.
  const nextRevealAt = useNextHalfDayRevealAt();
  const revealStamp = useMemo(() => {
    try { return formatPostmark(new Date(nextRevealAt).toISOString(), myTz); }
    catch { return ''; }
  }, [nextRevealAt, myTz]);

  const refreshUnreadFlag = useCallback(async () => {
    const [inbox, outbox] = await Promise.all([
      hasUnreadInboxItems(),
      hasFreshOutboxItems(),
    ]);
    setInboxHasUnread(inbox);
    setOutboxHasFresh(outbox);
  }, []);

  // Sticky wall state — drives the entry card's 小红旗 and auto-opens the
  // wall when an unposted temp exists, per the spec ("下次点到信箱界面，还
  // 停在没写完的临时便利贴上"). Auto-open is gated on focus / app-active so
  // socket events don't keep popping the modal.
  const refreshStickyFlag = useCallback(async (opts: { autoOpenIfTemp: boolean }) => {
    try {
      const res = await api.getStickies();
      setStickyHasUnread(res.stickies.some(s => s.unread));
      if (opts.autoOpenIfTemp && res.my_temp) {
        setStickyOpen(true);
      }
    } catch {}
  }, []);

  // Refresh on every focus + when the app comes back to foreground.
  useFocusEffect(
    useCallback(() => {
      refreshUnreadFlag();
      refreshStickyFlag({ autoOpenIfTemp: true });
      // Pull cached partner name for the 写信 → 择日达 → "给对方" label.
      storage.getPartnerName().then(n => { if (n) setPartnerName(n); }).catch(() => {});
      // Re-fetch tz on every focus so a Settings tz change is picked up
      // the next time the user navigates back — same pattern as DailyScreen.
      storage.getTimezone().then(tz => { if (tz) setMyTz(tz); }).catch(() => {});
    }, [refreshUnreadFlag, refreshStickyFlag])
  );

  useEffect(() => {
    const sub = RNAppState.addEventListener('change', (next) => {
      if (next === 'active') {
        refreshUnreadFlag();
        refreshStickyFlag({ autoOpenIfTemp: true });
      }
    });
    return () => sub.remove();
  }, [refreshUnreadFlag, refreshStickyFlag]);

  // Live updates from partner — flip 小红旗 immediately on post / append
  // without waiting for the next focus event.
  useEffect(() => {
    return subscribe('sticky_update', () => {
      refreshStickyFlag({ autoOpenIfTemp: false });
    });
  }, [refreshStickyFlag]);

  // Outbox-side: refresh 🚩 the moment WriteLetterScreen reports a
  // successful send, so the user gets immediate visual confirmation
  // without waiting for the next focus event.
  useEffect(() => {
    return subscribeOutboxChanged(() => {
      refreshUnreadFlag();
    });
  }, [refreshUnreadFlag]);

  // Scroll-bound fade — see UsScreen for the same pattern + rationale.
  const scrollY = useRef(new Animated.Value(0)).current;
  const fadeOpacity = scrollY.interpolate({
    inputRange: [0, 12],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        inboxRef.current?.reload(),
        outboxRef.current?.reload(),
        trashRef.current?.reload(),
        snapCalendarRef.current?.reload(),
        refreshUnreadFlag(),
        refreshStickyFlag({ autoOpenIfTemp: false }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [refreshUnreadFlag, refreshStickyFlag]);

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <Animated.ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: writePillBottom + 60 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.kiss}
          />
        }
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
        scrollEventThrottle={16}
      >
        <TouchableOpacity
          style={styles.entry}
          onPress={() => setInboxOpen(true)}
          activeOpacity={0.85}
        >
          <Text style={styles.entryEmoji}>📬</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.entryTitle}>收件箱</Text>
            <Text style={styles.entrySub}>已送达的半日达 · 已开启的择日达</Text>
          </View>
          {inboxHasUnread && <Text style={styles.unreadFlag}>🚩</Text>}
          <Text style={styles.entryArrow}>›</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.entry}
          onPress={() => setOutboxOpen(true)}
          activeOpacity={0.85}
        >
          <Text style={styles.entryEmoji}>📤</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.entryTitle}>发件箱</Text>
            <Text style={styles.entrySub}>在途的半日达 · 待解锁的择日达</Text>
          </View>
          {outboxHasFresh && <Text style={styles.unreadFlag}>🚩</Text>}
          <Text style={styles.entryArrow}>›</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.entry}
          onPress={() => setTrashOpen(true)}
          activeOpacity={0.85}
        >
          <Text style={styles.entryEmoji}>🗑️</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.entryTitle}>废件箱</Text>
            <Text style={styles.entrySub}>从收件箱删除的信件可以在这里恢复</Text>
          </View>
          <Text style={styles.entryArrow}>›</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.entry}
          onPress={() => setStickyOpen(true)}
          activeOpacity={0.85}
        >
          <Text style={styles.entryEmoji}>📝</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.entryTitle}>小贴吧</Text>
            <Text style={styles.entrySub}>双方共享的便利贴墙</Text>
          </View>
          {stickyHasUnread && <Text style={styles.unreadFlag}>🚩</Text>}
          <Text style={styles.entryArrow}>›</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.entry}
          onPress={() => setSnapCalendarOpen(true)}
          activeOpacity={0.85}
        >
          <Text style={styles.entryEmoji}>📷</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.entryTitle}>快照日历</Text>
            <Text style={styles.entrySub}>按月查看你们的每日快照</Text>
          </View>
          <Text style={styles.entryArrow}>›</Text>
        </TouchableOpacity>
      </Animated.ScrollView>

      {/* Scroll-bound top fade — see UsScreen for rationale. */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: insets.top + 12,
          height: 24,
          opacity: fadeOpacity,
        }}
      >
        <LinearGradient
          colors={[COLORS.background, 'rgba(255, 245, 245, 0)']}
          style={{ flex: 1 }}
        />
      </Animated.View>

      {/* 写信 floating pill — anchored at the bottom of the screen, just above
          the home indicator + tab bar. Replaces the old MailboxCard +
          TimeCapsuleCard cards inline; tapping it opens the unified
          letter-writing flow that branches to 半日达 / 择日达 after sealing. */}
      <View style={[styles.writePillSlot, { bottom: writePillBottom }]} pointerEvents="box-none">
        <SpringPressable
          onPress={() => setWriteOpen(true)}
          style={styles.writePill}
          scaleTo={1.06}
        >
          <Text style={styles.writePillText}>写信 ✉️</Text>
        </SpringPressable>
        {revealStamp ? (
          <Text style={styles.writeHint}>下个半日达将于 {revealStamp} 寄达</Text>
        ) : null}
      </View>

      <InboxScreen
        ref={inboxRef}
        visible={inboxOpen}
        onClose={() => {
          setInboxOpen(false);
          // Inbox open advances INBOX_LAST_SEEN to "now", so the flag should
          // clear immediately after the user closes it.
          refreshUnreadFlag();
        }}
      />
      <OutboxScreen
        ref={outboxRef}
        visible={outboxOpen}
        onClose={async () => {
          setOutboxOpen(false);
          // Opening the outbox marks all currently-pending letters as
          // seen on the server — clears the 🚩 + 信箱 tab dot until the
          // next send. Server-side state survives logout / reinstall.
          await api.markOutboxSeen().catch(() => {});
          refreshUnreadFlag();
        }}
        partnerName={partnerName}
      />
      <TrashScreen
        ref={trashRef}
        visible={trashOpen}
        onClose={() => setTrashOpen(false)}
        onAfterRestore={() => inboxRef.current?.reload()}
      />
      <StickyWallScreen
        ref={stickyRef}
        visible={stickyOpen}
        onClose={() => setStickyOpen(false)}
        onUnreadChange={setStickyHasUnread}
      />
      <SnapCalendarScreen
        ref={snapCalendarRef}
        visible={snapCalendarOpen}
        onClose={() => setSnapCalendarOpen(false)}
      />
      <WriteLetterScreen
        visible={writeOpen}
        onClose={() => setWriteOpen(false)}
        partnerName={partnerName}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    paddingHorizontal: 20,
    gap: 16,
  },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 14,
  },
  entryEmoji: {
    fontSize: 28,
  },
  entryTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  entrySub: {
    fontSize: 12,
    color: COLORS.textLight,
    marginTop: 2,
  },
  entryArrow: {
    fontSize: 22,
    color: COLORS.textLight,
    fontWeight: '300',
  },
  unreadFlag: {
    fontSize: 18,
    marginRight: 6,
  },
  // Floating 写信 pill anchored above the bottom tab bar. Bottom offset
  // is computed at render time as `insets.bottom + width * 0.175 + 16`
  // so it always sits exactly 16pt above the PillTabBar regardless of
  // device width — see writePillBottom in the component body.
  writePillSlot: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  writePill: {
    paddingHorizontal: 32,
    paddingVertical: 13,
    borderRadius: 26,
    backgroundColor: COLORS.kiss,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 14,
    elevation: 8,
    minWidth: 140,
    alignItems: 'center',
  },
  writePillText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  writeHint: {
    fontSize: 12,
    color: COLORS.textLight,
    textAlign: 'center',
    marginTop: 8,
  },
});
