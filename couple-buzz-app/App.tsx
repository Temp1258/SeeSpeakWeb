import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ActivityIndicator, Alert, View, Text, TextInput, StyleSheet, LogBox, AppState as RNAppState, useWindowDimensions } from 'react-native';

LogBox.ignoreLogs(['Could not access feature flag']);

// Global cap on Dynamic Type scaling. RN Text/TextInput respect the
// system font scale by default — at extreme accessibility settings (up
// to 3.1× on iOS) labels would overflow our fixed-height buttons / pills
// and clip badly. Capping at 1.4 lets users with mild large-text needs
// still get bigger text while protecting layout integrity. Setting
// defaultProps once here applies app-wide; individual Text components
// can override via their own `maxFontSizeMultiplier` prop.
(Text as any).defaultProps = (Text as any).defaultProps || {};
(Text as any).defaultProps.maxFontSizeMultiplier = 1.4;
(TextInput as any).defaultProps = (TextInput as any).defaultProps || {};
(TextInput as any).defaultProps.maxFontSizeMultiplier = 1.4;
import { NavigationContainer, createNavigationContainerRef, LinkingOptions } from '@react-navigation/native';
import { createMaterialTopTabNavigator, MaterialTopTabBarProps } from '@react-navigation/material-top-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';

import { COLORS } from './src/constants';
import { SpringPressable } from './src/components/SpringPressable';
import { ToolbarSlotContext } from './src/utils/toolbarSlot';
import { storage } from './src/utils/storage';
import { registerAndUpdateToken } from './src/services/notification';
import { api, AuthError } from './src/services/api';
import { connectSocket, disconnectSocket, subscribe } from './src/services/socket';
import { hasUnreadInboxItems } from './src/utils/inboxUnread';
import { refreshDeviceTimezoneCache } from './src/utils/timezone';
import SetupScreen from './src/screens/SetupScreen';
import HomeScreen from './src/screens/HomeScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import UsScreen from './src/screens/UsScreen';
import MailboxScreen from './src/screens/MailboxScreen';
import AnniversaryWishScreen from './src/screens/AnniversaryWishScreen';

const Tab = createMaterialTopTabNavigator();

// Single source of truth for app navigation: lets non-React code (e.g. push
// notification handlers) jump to a tab without going through navigation props.
const navigationRef = createNavigationContainerRef();

// Maps push action types to the tab the user expects to land on when they
// tap the notification. Anything not listed defaults to History (废话区) —
// most emoji actions surface there as feed entries.
const NOTIFICATION_TAB_ROUTES: Record<string, string> = {
  // 拍拍 (touch) — opens Home where the touch UI lives.
  touch: 'Home',

  // Daily content — answers, snaps, urges, reactions, ritual greetings.
  daily_answer: 'Us', daily_both: 'Us',
  snap_submitted: 'Us', snap_both: 'Us',
  urge_question: 'Us', urge_snap: 'Us',
  react_question_up: 'Us', react_question_down: 'Us',
  react_snap_up: 'Us', react_snap_down: 'Us',
  ritual_morning: 'Us', ritual_evening: 'Us',
  ritual_both_morning: 'Us', ritual_both_evening: 'Us',

  // Mailbox + capsules + stickies (每日一帖 lives in 信箱 tab).
  mailbox_open: 'Mailbox', mailbox_written: 'Mailbox',
  mailbox_countdown_15min: 'Mailbox', mailbox_reveal: 'Mailbox',
  capsule_unlock: 'Mailbox', capsule_buried: 'Mailbox',
  sticky_posted: 'Mailbox', sticky_appended: 'Mailbox',

  // Promises (bucket list + important dates).
  bucket_new: 'Promises', bucket_complete: 'Promises',
  date_new: 'Promises',

  // Weekly stats.
  weekly_report: 'Settings',
};

const tabForActionType = (t?: string): string =>
  (t && NOTIFICATION_TAB_ROUTES[t]) || 'History';

// react-navigation linking config — the canonical pattern for routing a
// tapped notification to its corresponding tab. Solves cold-launch race
// (getInitialURL is consulted before any screen renders) and warm-tap
// (subscribe pipes future taps to the navigator). Replaces the prior
// useLastNotificationResponse + manual nav-queue dance, which lost taps
// on iOS in some lifecycle paths.
const TAB_PATHS: Record<string, string> = {
  Home: 'home',
  History: 'history',
  Us: 'us',
  Mailbox: 'mailbox',
  Promises: 'promises',
  Settings: 'settings',
};
const targetToUrl = (target: string) => `couplebuzz://${TAB_PATHS[target] ?? 'home'}`;
const urlForResponse = (response: Notifications.NotificationResponse): string => {
  const data = response.notification.request.content.data as { actionType?: string };
  return targetToUrl(tabForActionType(data?.actionType));
};

// Defer cold-start notification routing until the app is fully `ready`
// (logged in + paired + main tabs mounted). Without the deferral, taps
// from a logged-out / mid-pairing state get silently consumed because
// the target tab doesn't exist yet, leaving the user staring at the
// wrong screen until they navigate manually.
//
// Runtime taps (app already in foreground / background) are still
// handled by the standard linking subscription — those land on a fully-
// mounted nav tree.
const notificationLinking: LinkingOptions<ReactNavigation.RootParamList> = {
  prefixes: ['couplebuzz://'],
  config: {
    screens: {
      Home: 'home',
      History: 'history',
      Us: 'us',
      Mailbox: 'mailbox',
      Promises: 'promises',
      Settings: 'settings',
    },
  },
  // No getInitialURL here — cold-start is handled by the App-level effect
  // that runs after appState transitions to 'ready'.
  subscribe(listener) {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      listener(urlForResponse(response));
    });
    return () => sub.remove();
  },
};

// WeChat-style small red dot anchored to the icon's top-right corner.
function TabIconWithDot({ emoji, color, dot }: { emoji: string; color: string; dot: boolean }) {
  return (
    <View>
      <Text style={{ fontSize: 20, color }}>{emoji}</Text>
      {dot && (
        <View style={{
          position: 'absolute',
          top: -2,
          right: -6,
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: COLORS.kiss,
        }} />
      )}
    </View>
  );
}

type AppState = 'loading' | 'setup' | 'waiting' | 'ready';

function PillTab({
  isFocused, label, renderIcon, onPress, pillH, radius, labelSize,
}: {
  isFocused: boolean;
  label: string;
  renderIcon: ((props: { focused: boolean; color: string }) => React.ReactNode) | undefined;
  onPress: () => void;
  pillH: number;
  radius: number;
  labelSize: number;
}) {
  const tint = isFocused ? COLORS.white : COLORS.textLight;

  return (
    <SpringPressable
      // Switch on touch-down (onPressIn) instead of touch-up (onPress) so the
      // screen flips the moment the finger lands, not after release. Saves
      // the finger-hold window (~80-150ms) — perceptually "instant". The
      // spring + haptic still play in parallel as visual feedback.
      onPressIn={onPress}
      wrapperStyle={{ flex: 1 }}
      style={{
        height: pillH,
        borderRadius: radius,
        backgroundColor: isFocused ? COLORS.kiss : COLORS.white,
        borderWidth: isFocused ? 0 : 1,
        borderColor: COLORS.border,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 6,
        elevation: 2,
      }}
    >
      {renderIcon && renderIcon({ focused: isFocused, color: tint })}
      <Text style={{
        fontSize: labelSize,
        fontWeight: '600',
        color: tint,
        marginTop: 2,
      }}>{label}</Text>
    </SpringPressable>
  );
}

// Pill-shaped (灵动岛) bottom tab bar. All sizing is proportional to screen
// width via useWindowDimensions, so the bar reflows on rotation / different
// device widths instead of looking off on small/large screens.
function PillTabBar({ state, descriptors, navigation }: MaterialTopTabBarProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const sidePad = width * 0.03;
  const gap = width * 0.012;
  const pillH = width * 0.14;
  const radius = pillH * 0.36;
  const labelSize = width * 0.028;

  // Fade-up overlay floats ABOVE the solid bar slot so screen content visibly
  // fades into the bar instead of the "transparent" top just revealing the
  // same flat tint. Height ~16% of screen width gives a soft 60-70pt ramp.
  const fadeH = width * 0.16;
  const fadeColors = useMemo(
    () => ['rgba(255,245,245,0)', COLORS.background] as [string, string],
    []
  );

  return (
    <View>
      <LinearGradient
        colors={fadeColors}
        locations={[0, 1]}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: -fadeH,
          height: fadeH,
        }}
        pointerEvents="none"
      />
      <View style={{
        flexDirection: 'row',
        gap,
        paddingHorizontal: sidePad,
        paddingTop: width * 0.02,
        paddingBottom: insets.bottom + width * 0.015,
        backgroundColor: COLORS.background,
      }}>
        {state.routes.map((route, index) => {
          const isFocused = state.index === index;
          const { options } = descriptors[route.key];
          const label = options.tabBarLabel as string;
          const renderIcon = options.tabBarIcon;

          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          return (
            <PillTab
              key={route.key}
              isFocused={isFocused}
              label={label}
              renderIcon={renderIcon}
              onPress={onPress}
              pillH={pillH}
              radius={radius}
              labelSize={labelSize}
            />
          );
        })}
      </View>
    </View>
  );
}

function MainTabs({
  partnerName, streak, hasUnread, hasUnreadDaily, hasUnreadHome, hasUnreadMail, hasUnreadPromises, onLatestSeen, onSelfRevoked,
}: {
  partnerName: string;
  streak: number;
  hasUnread: boolean;
  hasUnreadDaily: boolean;
  hasUnreadHome: boolean;
  hasUnreadMail: boolean;
  hasUnreadPromises: boolean;
  onLatestSeen: (id: number) => void;
  onSelfRevoked: () => void;
}) {
  return (
    <Tab.Navigator
      tabBarPosition="bottom"
      tabBar={(props) => <PillTabBar {...props} />}
      screenOptions={{
        // Swipe-between-tabs is part of the UX. Disabling pager animation on
        // taps (animationEnabled: false) keeps rapid taps from queueing up
        // tween calls behind each other — the gesture-driven swipe still
        // animates via the native pager's own physics on release.
        swipeEnabled: true,
        animationEnabled: false,
      }}
    >
      <Tab.Screen
        name="Home"
        options={{
          tabBarLabel: '拍拍',
          tabBarIcon: ({ color }) => <TabIconWithDot emoji="🤚" color={color} dot={hasUnreadHome} />,
        }}
      >
        {() => <HomeScreen partnerName={partnerName} streak={streak} />}
      </Tab.Screen>
      <Tab.Screen
        name="History"
        options={{
          tabBarLabel: '废话区',
          tabBarIcon: ({ color }) => <TabIconWithDot emoji="💬" color={color} dot={hasUnread} />,
        }}
      >
        {() => <HistoryScreen partnerName={partnerName} onLatestSeen={onLatestSeen} />}
      </Tab.Screen>
      <Tab.Screen
        name="Us"
        component={UsScreen}
        options={{
          tabBarLabel: '每日',
          tabBarIcon: ({ color }) => <TabIconWithDot emoji="📅" color={color} dot={hasUnreadDaily} />,
        }}
      />
      <Tab.Screen
        name="Mailbox"
        component={MailboxScreen}
        options={{
          tabBarLabel: '信箱',
          tabBarIcon: ({ color }) => <TabIconWithDot emoji="📮" color={color} dot={hasUnreadMail} />,
        }}
      />
      <Tab.Screen
        name="Promises"
        component={AnniversaryWishScreen}
        options={{
          tabBarLabel: '约定',
          tabBarIcon: ({ color }) => <TabIconWithDot emoji="🎀" color={color} dot={hasUnreadPromises} />,
        }}
      />
      <Tab.Screen
        name="Settings"
        options={{
          tabBarLabel: '数据',
          tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>📊</Text>,
        }}
      >
        {() => <SettingsScreen onSelfRevoked={onSelfRevoked} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

export default function App() {
  const [appState, setAppState] = useState<AppState>('loading');
  const [partnerName, setPartnerName] = useState('');
  const [streak, setStreak] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const lastSeenIdRef = useRef(0);
  const [hasUnread, setHasUnread] = useState(false);
  const [hasUnreadDaily, setHasUnreadDaily] = useState(false);
  const [hasUnreadMail, setHasUnreadMail] = useState(false);
  const [hasUnreadPromises, setHasUnreadPromises] = useState(false);
  const [hasUnreadHome, setHasUnreadHome] = useState(false);
  const activeTabRef = useRef('Home');
  const myUserIdRef = useRef('');
  const [overlay, setOverlay] = useState<React.ReactNode>(null);
  const toolbarSlot = useMemo(() => ({ set: setOverlay }), []);

  // Drop the cached timezone on every foreground transition so a user
  // who changed iOS Settings → 通用 → 日期与时间while the app was in
  // the background sees the new value reflected on the next API call /
  // history grouping. Without this, the cached value sticks until app
  // kill — confusing for cross-timezone travel.
  useEffect(() => {
    const sub = RNAppState.addEventListener('change', (next) => {
      if (next === 'active') refreshDeviceTimezoneCache();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    (async () => {
      const userId = await storage.getUserId();
      if (!userId) {
        setAppState('setup');
        return;
      }
      myUserIdRef.current = userId;

      try {
        const status = await api.getStatus();
        // Cache the user's own name so screens that display it (InboxScreen,
        // OutboxScreen, etc.) don't fall back to "我" for users who logged in
        // (vs registered) and never saved in Settings.
        if (status.name) await storage.setUserName(status.name);
        // Cache both timezones so the very next screen (WriteLetterScreen
        // double-tz preview, InboxScreen postmarks, MailboxScreen next-
        // delivery hint, etc.) reads the server's source of truth instead
        // of falling back to 'Asia/Shanghai'. Without this, a logged-in
        // user who set partner_timezone = America/New_York in Settings
        // on a different device would still see "ta 那边收到时" rendered
        // in Beijing time until they manually visited Settings.
        if (status.timezone) await storage.setTimezone(status.timezone);
        if (status.partner_timezone) await storage.setPartnerTimezone(status.partner_timezone);
        if (status.partner_remark) await storage.setPartnerRemark(status.partner_remark);
        if (status.paired && status.partner_name) {
          await storage.setPartnerName(status.partner_name);
          setPartnerName(status.partner_name);
          setStreak(status.streak ?? 0);
          setAppState('ready');
          registerAndUpdateToken();
        } else {
          setAppState('waiting');
        }
      } catch (error) {
        if (error instanceof AuthError) {
          // Server explicitly rejected the session — wipe and re-login.
          // If another device just kicked us, surface a specific message
          // so the user understands why they're being bounced to setup.
          if (error.code === 'session_revoked') {
            Alert.alert('已退出登录', '此账号在另一台设备上将本机强制下线了。');
          }
          await storage.clearAll();
          setAppState('setup');
        } else {
          // Network / DNS / wrong URL / 5xx — fall back to cached state so
          // a transient hiccup doesn't kick the user out of their session.
          const cachedPartnerName = await storage.getPartnerName();
          if (cachedPartnerName) {
            setPartnerName(cachedPartnerName);
            setStreak(0);
            setAppState('ready');
            registerAndUpdateToken();
          } else {
            setAppState('waiting');
          }
        }
      }
    })();
  }, []);

  useEffect(() => {
    if (appState !== 'waiting') return;

    const check = async () => {
      try {
        const status = await api.getStatus();
        if (status.name) await storage.setUserName(status.name);
        if (status.timezone) await storage.setTimezone(status.timezone);
        if (status.partner_timezone) await storage.setPartnerTimezone(status.partner_timezone);
        if (status.partner_remark) await storage.setPartnerRemark(status.partner_remark);
        if (status.paired && status.partner_name) {
          await storage.setPartnerName(status.partner_name);
          setPartnerName(status.partner_name);
          setStreak(status.streak ?? 0);
          const uid = await storage.getUserId();
          if (uid) myUserIdRef.current = uid;
          setAppState('ready');
          registerAndUpdateToken();
        }
      } catch (err) {
        if (err instanceof AuthError) {
          await storage.clearAll();
          setAppState('setup');
        }
      }
    };

    // Pair-waiting screen polls every 3s — but only while the app is
    // foregrounded. Without this, a user who registers and pockets the
    // phone with the waiting screen still up keeps firing /status every
    // 3s in the background, draining battery / data over time. We pause
    // on AppState !== 'active' and resume on the next 'active' edge.
    const startPolling = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      check();
      pollRef.current = setInterval(check, 3000);
    };
    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = undefined;
      }
    };

    if (RNAppState.currentState === 'active') startPolling();
    const sub = RNAppState.addEventListener('change', (next) => {
      if (next === 'active') startPolling();
      else stopPolling();
    });

    return () => {
      sub.remove();
      stopPolling();
    };
  }, [appState]);

  // Bootstrap last-seen-id once on ready. The unread red dot is now driven
  // entirely by the socket `action_new` event + the foreground push
  // listener — both already wired below — so the prior 10s polling here
  // (which fired alongside HistoryScreen's own poll, doubling traffic) is
  // gone. Initial fetch still runs so handleLatestSeen has a sensible
  // starting cursor for mark-read.
  useEffect(() => {
    if (appState !== 'ready') return;
    let cancelled = false;
    (async () => {
      try {
        const result = await api.getHistory(1);
        if (cancelled) return;
        if (result.actions.length > 0) {
          lastSeenIdRef.current = result.actions[0].id;
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [appState]);

  // Foreground = clear the visual icon badge so a stale "5" doesn't linger.
  // We deliberately do NOT advance the server's last_read pointer here —
  // that only happens when the user actually views HistoryScreen (see
  // handleLatestSeen). The next push will recompute badge from real unread.
  //
  // Also reset the SERVER-side transient push counter (see pushToUser /
  // /api/badge-ack) so the +1-per-push sequence restarts from 0. Without
  // this the counter would only grow, leaving the badge unboundedly high
  // even after the user has clearly acknowledged the notifications by
  // opening the app.
  useEffect(() => {
    Notifications.setBadgeCountAsync(0);
    api.ackBadge().catch(() => {});
    const sub = RNAppState.addEventListener('change', (next) => {
      if (next === 'active') {
        Notifications.setBadgeCountAsync(0);
        api.ackBadge().catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  // Detect new partner activity on 每日 tab (daily question or daily snap).
  // Compares server state vs last-seen state stored locally; sets the red
  // dot if partner has done something new since user last visited the tab.
  useEffect(() => {
    if (appState !== 'ready') return;

    const checkDaily = async () => {
      try {
        const [dq, sn] = await Promise.all([
          api.getDailyQuestion(),
          api.getSnapToday(),
        ]);
        const seen = await api.getDailySeen();
        const isSameDay = seen.date === dq.date;
        const newPA = dq.partner_answered && (!isSameDay || !seen.pa);
        const newPS = sn.partner_snapped && (!isSameDay || !seen.ps);
        if (newPA || newPS) {
          if (activeTabRef.current !== 'Us') {
            setHasUnreadDaily(true);
          } else {
            // Already on the tab — mark as seen
            await api.setDailySeen(dq.date, dq.partner_answered, sn.partner_snapped);
          }
        }
      } catch {}
    };

    checkDaily();
    const sub = RNAppState.addEventListener('change', (next) => {
      if (next === 'active') checkDaily();
    });
    return () => sub.remove();
  }, [appState]);

  // Mark the target tab as unread (red dot). Only flips state when the user
  // is on a different tab — being on the tab means they're already seeing
  // the content. Used by both the foreground push listener and the tap
  // listener (so even if navigation is delayed, the dot still surfaces).
  const setUnreadForTab = useCallback((target: string) => {
    if (target === activeTabRef.current) return;
    if (target === 'Us') setHasUnreadDaily(true);
    else if (target === 'Mailbox') setHasUnreadMail(true);
    else if (target === 'Promises') setHasUnreadPromises(true);
    else if (target === 'Home') setHasUnreadHome(true);
    else if (target === 'History') setHasUnread(true);
  }, []);

  // Listen for foreground push notifications and flag the corresponding tab.
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data as { actionType?: string };
      setUnreadForTab(tabForActionType(data?.actionType));
    });
    return () => sub.remove();
  }, [setUnreadForTab]);

  // Cold-start notification handoff. If the user launched the app by
  // tapping a notification but wasn't logged in / paired yet, the URL
  // would land on a navigator that hadn't mounted the target tab. We
  // wait until appState='ready' (MainTabs is in the tree), then read
  // the cached response, navigate, and clear so a subsequent icon-
  // launch doesn't re-route to the same stale push.
  const coldStartConsumedRef = useRef(false);
  useEffect(() => {
    // Reset whenever we leave 'ready' so the next entry (e.g. force-logout
    // from another device → user re-logs in same process) can consume any
    // notification that arrived during the re-login window. Without this
    // reset, the second 'ready' transition silently skips navigation and
    // the user lands on the default tab instead of the tapped one.
    if (appState !== 'ready') {
      coldStartConsumedRef.current = false;
      return;
    }
    if (coldStartConsumedRef.current) return;
    coldStartConsumedRef.current = true;
    (async () => {
      try {
        const response = await Notifications.getLastNotificationResponseAsync();
        if (!response) return;
        const data = response.notification.request.content.data as { actionType?: string };
        const target = tabForActionType(data?.actionType);
        if (navigationRef.isReady()) {
          navigationRef.navigate(target as never);
        }
        Notifications.clearLastNotificationResponseAsync();
      } catch {}
    })();
  }, [appState]);

  // Foreground 拍拍 (touch) arrives via socket — server skips the push when
  // both sides have a live socket. Mirror it into hasUnreadHome so the red
  // dot still appears when the partner pats while we're on a different tab.
  useEffect(() => {
    if (appState !== 'ready') return;
    return subscribe('touch_start', () => setUnreadForTab('Home'));
  }, [appState, setUnreadForTab]);

  // Live ping when the partner posts a new emoji/reaction in 废话区. Server
  // suppresses the push when the recipient is foregrounded (online), so this
  // socket event is the sole driver of both the haptic and the History red
  // dot in that case. Sender's own client receives it too — filter via `from`.
  useEffect(() => {
    if (appState !== 'ready') return;
    return subscribe('action_new', (data: { from?: string }) => {
      if (!data?.from || data.from === myUserIdRef.current) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setUnreadForTab('History');
    });
  }, [appState, setUnreadForTab]);

  // Tap fallback: navigation itself is handled by NavigationContainer's
  // `linking` prop, which is the canonical react-navigation pattern. This
  // listener exists purely to mark the target tab unread so a red dot still
  // appears as a fallback. When linking succeeds, the immediate navigation
  // triggers onStateChange, which clears the dot — the user only ever sees
  // it if linking somehow didn't navigate.
  useEffect(() => {
    if (appState !== 'ready') return;
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { actionType?: string };
      setUnreadForTab(tabForActionType(data?.actionType));
    });
    return () => sub.remove();
  }, [appState, setUnreadForTab]);

  // 信箱 tab 红点 — push-driven path covers foreground-receive and tap, but
  // misses three cases: cold launch via app icon (push consumed by OS, no
  // listener fires), foreground+online (server skips push when socket alive,
  // emits sticky_update only), and background→foreground without tapping the
  // notification. Mirror MailboxScreen's own refresh triggers here so the tab
  // dot reflects sticky/inbox unread independently of the push pipeline.
  //
  // Only partner→me signals (sticky / inbox) drive the tab dot. The user's
  // own outgoing letters (outbox 🚩) intentionally do NOT light the tab —
  // see MailboxScreen for the 🚩 on the 📤 entry card, which is the
  // dedicated affordance for "you have unseen pending sends".
  useEffect(() => {
    if (appState !== 'ready') return;

    const check = async () => {
      try {
        const [stickyRes, inboxUnread] = await Promise.all([
          api.getStickies().catch(() => null),
          hasUnreadInboxItems().catch(() => false),
        ]);
        const stickyUnread = stickyRes?.stickies.some(s => s.unread) ?? false;
        if (stickyUnread || inboxUnread) setUnreadForTab('Mailbox');
      } catch {}
    };

    check();
    const appSub = RNAppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    const unsubSocket = subscribe('sticky_update', (data: { from?: string }) => {
      if (data?.from && data.from === myUserIdRef.current) return;
      check();
    });

    return () => {
      appSub.remove();
      unsubSocket();
    };
  }, [appState, setUnreadForTab]);

  const handleDailyTabFocus = useCallback(async () => {
    setHasUnreadDaily(false);
    try {
      const [dq, sn] = await Promise.all([
        api.getDailyQuestion(),
        api.getSnapToday(),
      ]);
      await api.setDailySeen(dq.date, dq.partner_answered, sn.partner_snapped);
    } catch {}
  }, []);

  // Socket lifecycle: connect when ready, handle foreground/background
  useEffect(() => {
    if (appState !== 'ready') return;

    connectSocket();

    const sub = RNAppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        connectSocket();
      } else {
        disconnectSocket();
      }
    });

    return () => {
      sub.remove();
      disconnectSocket();
    };
  }, [appState]);

  const handleLatestSeen = useCallback((id: number) => {
    if (id > lastSeenIdRef.current) lastSeenIdRef.current = id;
    setHasUnread(false);
    // Push the new high-water mark to the server so badge counts reset.
    Notifications.setBadgeCountAsync(0);
    if (id > 0) {
      api.markRead(id).catch(() => {});
    }
  }, []);

  // Triggered when the user revokes their own session from
  // DeviceListCard, OR when an authenticated request bounces with
  // session_revoked from another device's force-logout. Same recovery
  // path either way: nuke local state and pop back to login.
  const handleSelfRevoked = useCallback(async () => {
    disconnectSocket();
    await storage.clearAll();
    setAppState('setup');
  }, []);

  const handleRegistered = useCallback(async (result: { partner_name: string | null }) => {
    const uid = await storage.getUserId();
    if (uid) myUserIdRef.current = uid;

    if (result.partner_name) {
      await storage.setPartnerName(result.partner_name);
      // Pull tz settings off the server immediately on fresh login so the
      // very first screen the user lands on (WriteLetterScreen preview /
      // InboxScreen postmark / MailboxScreen 下次送达 hint) already shows
      // the correct double-tz instead of falling back to Asia/Shanghai.
      // api.login doesn't include tz in its response by design; getStatus
      // does. Fire-and-forget — login already succeeded, a transient fetch
      // failure shouldn't block the ready transition.
      api.getStatus().then(async (status) => {
        if (status.timezone) await storage.setTimezone(status.timezone);
        if (status.partner_timezone) await storage.setPartnerTimezone(status.partner_timezone);
        if (status.partner_remark) await storage.setPartnerRemark(status.partner_remark);
      }).catch(() => {});
      setPartnerName(result.partner_name);
      setAppState('ready');
      registerAndUpdateToken();
    } else {
      setAppState('waiting');
    }
  }, []);

  if (appState === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.kiss} />
      </View>
    );
  }

  if (appState === 'setup') {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <SetupScreen onRegistered={handleRegistered} />
      </SafeAreaProvider>
    );
  }

  if (appState === 'waiting') {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <View style={styles.center}>
          <Text style={styles.waitingEmoji}>💕</Text>
          <Text style={styles.waitingTitle}>等待对方加入...</Text>
          <Text style={styles.waitingSubtitle}>对方注册后将自动配对</Text>
          <ActivityIndicator style={styles.waitingSpinner} color={COLORS.kiss} />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <ToolbarSlotContext.Provider value={toolbarSlot}>
        <View style={styles.appRoot}>
          <NavigationContainer
            ref={navigationRef}
            linking={notificationLinking}
            onStateChange={(state) => {
              if (!state) return;
              const route = state.routes[state.index];
              activeTabRef.current = route.name;
              if (route.name === 'History') setHasUnread(false);
              if (route.name === 'Us') handleDailyTabFocus();
              if (route.name === 'Mailbox') setHasUnreadMail(false);
              if (route.name === 'Promises') setHasUnreadPromises(false);
              if (route.name === 'Home') setHasUnreadHome(false);
            }}
          >
            <MainTabs
              partnerName={partnerName}
              streak={streak}
              hasUnread={hasUnread}
              hasUnreadDaily={hasUnreadDaily}
              hasUnreadHome={hasUnreadHome}
              hasUnreadMail={hasUnreadMail}
              hasUnreadPromises={hasUnreadPromises}
              onLatestSeen={handleLatestSeen}
              onSelfRevoked={handleSelfRevoked}
            />
          </NavigationContainer>
          {overlay && (
            <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
              {overlay}
            </View>
          )}
        </View>
      </ToolbarSlotContext.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  appRoot: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
  },
  waitingEmoji: {
    fontSize: 64,
    marginBottom: 16,
  },
  waitingTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 8,
  },
  waitingSubtitle: {
    fontSize: 16,
    color: COLORS.textLight,
  },
  waitingSpinner: {
    marginTop: 32,
  },
});
