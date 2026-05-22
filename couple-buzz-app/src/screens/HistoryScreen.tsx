import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  SectionList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Pressable,
  Dimensions,
  Animated,
  PanResponder,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useTabAnimation } from '@react-navigation/material-top-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, ACTION_EMOJI, ACTION_CATEGORIES, ActionConfig } from '../constants';
import { api, HistoryAction } from '../services/api';
import { subscribe } from '../services/socket';
import { storage } from '../utils/storage';
import { getDeviceTimezone } from '../utils/timezone';
import { normalizeIso } from '../utils/inboxUnread';
import ActionRecord from '../components/ActionRecord';
import { SpringPressable } from '../components/SpringPressable';
import { useToolbarSlot } from '../utils/toolbarSlot';

const SCREEN_HEIGHT = Dimensions.get('window').height;
const TOOLBAR_HEIGHT = 56;
const PANEL_HEIGHT = SCREEN_HEIGHT * 0.5 - TOOLBAR_HEIGHT;
// Panel sits above the toolbar (`bottom: TOOLBAR_HEIGHT`). To fully hide it
// off-screen we need to translate by panel height + toolbar height; otherwise
// the dragHandle and the first row of the emoji grid peek out above the pill.
const PANEL_HIDDEN = PANEL_HEIGHT + TOOLBAR_HEIGHT;
const COLUMNS = 5;
const PANEL_PADDING_X = 12;
const COL_GAP = 8;
const ROW_GAP = 8;

const TIMEZONE_LABELS: Record<string, string> = {
  'Asia/Shanghai': '北京时间 (UTC+8)',
  'Asia/Hong_Kong': '香港 (UTC+8)',
  'Asia/Taipei': '台北 (UTC+8)',
  'Asia/Tokyo': '东京 (UTC+9)',
  'Asia/Seoul': '首尔 (UTC+9)',
  'Asia/Singapore': '新加坡 (UTC+8)',
  'America/New_York': '纽约 (UTC-5)',
  'America/Los_Angeles': '洛杉矶 (UTC-8)',
  'America/Chicago': '芝加哥 (UTC-6)',
  'Europe/London': '伦敦 (UTC+0)',
  'Europe/Paris': '巴黎 (UTC+1)',
  'Europe/Berlin': '柏林 (UTC+1)',
  'Australia/Sydney': '悉尼 (UTC+11)',
  'Pacific/Auckland': '奥克兰 (UTC+13)',
};

// "Read here" pseudo-row injected between the last-read and first-unread
// action in 废话区 — keyed off id=-1 so SectionList's keyExtractor stays
// happy and renderItem can branch on the marker.
type DividerItem = { id: -1; _divider: true };
// v1.2.20 — same-emoji-same-sender bursts within 5 min collapse into a
// single bubble with a ×NN badge. The "leader" (first member) keeps its
// id as the React key so the bubble doesn't re-mount when more emoji
// join the burst — that's required for ActionRecord's count-bump
// animation to play smoothly. displayCreatedAt rolls forward to the
// latest member's timestamp (the bubble shows "ta sent this most
// recently at ..."), and latestId surfaces the newest member's id for
// the unread-divider boundary check.
type GroupedAction = HistoryAction & {
  count?: number;
  displayCreatedAt?: string;
  latestId?: number;
};
type ListItem = GroupedAction | DividerItem;
const isDivider = (item: ListItem): item is DividerItem =>
  (item as DividerItem)._divider === true;

// "Burst" = consecutive run of same (user_id, action_type) where each
// member's created_at is within BURST_WINDOW_MS of the PREVIOUS member.
// Rolling window — a sustained barrage keeps merging as long as no
// 5-min gap interrupts it. Operates per Section (i.e. per local day in
// the user's tz) so a same-emoji pair straddling midnight does not
// silently merge across the day separator the user sees on screen.
const BURST_WINDOW_MS = 5 * 60 * 1000;

// v1.2.20 — fallback rendering when the user hasn't picked a custom
// 废话区 title (history_title === '' on the server).
const DEFAULT_HISTORY_TITLE = '香宝聚集地 💕';
// Cap matches HISTORY_TITLE_MAX in routes.ts; doubled validation keeps
// the iOS prompt's character UX consistent with what the server accepts.
const HISTORY_TITLE_MAX_CHARS = 30;

function collapseBursts(actions: HistoryAction[]): GroupedAction[] {
  const out: GroupedAction[] = [];
  for (const action of actions) {
    const t = new Date(normalizeIso(action.created_at)).getTime();
    const last = out[out.length - 1];
    const lastT = last
      ? new Date(normalizeIso(last.displayCreatedAt ?? last.created_at)).getTime()
      : 0;
    if (
      last &&
      last.user_id === action.user_id &&
      last.action_type === action.action_type &&
      t - lastT <= BURST_WINDOW_MS
    ) {
      last.count = (last.count ?? 1) + 1;
      last.displayCreatedAt = action.created_at;
      last.latestId = action.id;
    } else {
      // Even singletons get count/displayCreatedAt/latestId set so the
      // renderer and unread-divider code don't have to special-case
      // ungrouped items.
      out.push({
        ...action,
        count: 1,
        displayCreatedAt: action.created_at,
        latestId: action.id,
      });
    }
  }
  return out;
}

interface Section {
  title: string;
  data: ListItem[];
}

interface Props {
  partnerName: string;
  onLatestSeen?: (id: number) => void;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function CompactActionButton({ action, onPress }: { action: ActionConfig; onPress: (t: string) => void }) {
  // Spring "card pickup" motion (same primitive as the bottom tab pills) —
  // scales UP on press-in with a bouncy overshoot, springs back on release.
  // Replaces the old shrink-then-return tween, which felt flat by comparison.
  return (
    <SpringPressable
      onPress={() => onPress(action.type)}
      onPressIn={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
      haptic={false}
      scaleTo={1.2}
      wrapperStyle={styles.compactWrapper}
      style={[styles.compactButton, { backgroundColor: action.color }]}
    >
      <Text style={styles.compactEmoji}>{action.emoji}</Text>
      <Text style={styles.compactLabel} numberOfLines={1}>{action.label}</Text>
    </SpringPressable>
  );
}

function formatTimeInZone(dateStr: string, timezone: string): string {
  // SQLite default 'YYYY-MM-DD HH:MM:SS' (no T, no Z) is parse-undefined per
  // ECMA-262. Hermes (RN 0.81 default) returns Invalid Date for some inputs
  // of this shape — normalizeIso converts to canonical 'YYYY-MM-DDTHH:MM:SSZ'
  // before handing to the Date constructor.
  const date = new Date(normalizeIso(dateStr));
  try {
    return date.toLocaleTimeString('zh-CN', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }
}

// Shared cache lives in utils/timezone — a single Intl lookup per
// session, refreshed only on app-foreground via the AppState wiring in
// App.tsx so a Settings-app timezone change still surfaces.

// Insert the unread-divider into the section that contains the first PARTNER
// action (or BURST) with any id > boundaryId. Self-sent messages don't count
// as "unread" — they're visible in the recipient's feed but the recipient
// never had to be notified about them. Sections are oldest-first.
//
// For burst-collapsed groups (v1.2.20), we compare against `latestId` (the
// newest member's id) — any group that has even one fresh emoji should
// surface BELOW the divider so the user notices, even if older members of
// the same group sit ABOVE the boundary chronologically.
function injectUnreadDivider(sections: Section[], boundaryId: number, myUserId: string): Section[] {
  if (boundaryId <= 0 || !myUserId) return sections;
  let inserted = false;
  return sections.map((s) => {
    if (inserted) return s;
    let insertIdx = -1;
    for (let i = 0; i < s.data.length; i++) {
      const it = s.data[i];
      if (isDivider(it)) continue;
      const newestIdInItem = (it as GroupedAction).latestId ?? it.id;
      if (newestIdInItem > boundaryId && it.user_id !== myUserId) {
        insertIdx = i;
        break;
      }
    }
    if (insertIdx < 0) return s;
    inserted = true;
    const divider: DividerItem = { id: -1, _divider: true };
    return {
      ...s,
      data: [...s.data.slice(0, insertIdx), divider, ...s.data.slice(insertIdx)],
    };
  });
}

function UnreadDivider({
  dismissed,
  onFadeComplete,
}: {
  dismissed: boolean;
  onFadeComplete: () => void;
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  const calledRef = useRef(false);
  useEffect(() => {
    if (!dismissed) {
      // Coming back to "visible" (e.g. focus reset after a previous fade) —
      // snap fully opaque so the next dismiss fades from a clean state.
      opacity.setValue(1);
      calledRef.current = false;
      return;
    }
    Animated.timing(opacity, {
      toValue: 0,
      duration: 400,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished || calledRef.current) return;
      calledRef.current = true;
      onFadeComplete();
    });
  }, [dismissed, opacity, onFadeComplete]);

  return (
    <Animated.View style={[dividerStyles.row, { opacity }]}>
      <View style={dividerStyles.line} />
      <View style={dividerStyles.pill}>
        <Text style={dividerStyles.label}>以下为新消息</Text>
      </View>
      <View style={dividerStyles.line} />
    </Animated.View>
  );
}

const dividerStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    marginTop: 18,
    marginBottom: 10,
    gap: 12,
  },
  line: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.kiss,
    opacity: 0.5,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 143, 171, 0.12)',
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.kiss,
    letterSpacing: 0.6,
  },
});

// Format a Date as YYYY-MM-DD in the supplied tz. Falls back to UTC slice
// if the runtime can't resolve the tz (very rare; safety net).
function localDateStringInTz(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// Group actions by the user's-own-timezone calendar day (the timezone they
// picked in 数据 tab). The previous version sliced UTC strings, which gave
// non-UTC users a wrong "今天/昨天" boundary every day around midnight (BJT
// users before 8am, NY users after 7pm).
function groupByDate(actions: HistoryAction[], myTz: string): Section[] {
  const groups: Record<string, HistoryAction[]> = {};
  const now = new Date();
  const todayStr = localDateStringInTz(now, myTz);
  const yesterdayStr = localDateStringInTz(new Date(now.getTime() - 86400000), myTz);

  for (const action of actions) {
    // Server timestamps are SQLite-default 'YYYY-MM-DD HH:MM:SS' in UTC.
    // Use normalizeIso so the result is canonical ISO 'YYYY-MM-DDTHH:MM:SSZ'
    // — Hermes parses raw "<space>Z" as Invalid Date in some configurations.
    const utcDate = new Date(normalizeIso(action.created_at));
    const dateStr = localDateStringInTz(utcDate, myTz);
    let label: string;

    if (dateStr === todayStr) {
      label = '今天';
    } else if (dateStr === yesterdayStr) {
      label = '昨天';
    } else {
      label = dateStr;
    }

    if (!groups[label]) groups[label] = [];
    groups[label].push(action);
  }

  // Run burst collapse PER DAY so a barrage doesn't accidentally merge
  // across the visible "今天 / 昨天" separator. Within each day the run
  // is still bounded by BURST_WINDOW_MS, so distinct emoji sprees stay
  // as distinct bubbles.
  return Object.entries(groups).map(([title, data]) => ({
    title,
    data: collapseBursts(data),
  }));
}

export default function HistoryScreen({ partnerName, onLatestSeen }: Props) {
  const insets = useSafeAreaInsets();
  const [sections, setSections] = useState<Section[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [myUserId, setMyUserId] = useState('');
  const [myTz, setMyTz] = useState(getDeviceTimezone());
  const [partnerTz, setPartnerTz] = useState('Asia/Shanghai');
  const [partnerRemark, setPartnerRemark] = useState('');
  // v1.2.20 — user-customizable 废话区 title (long-press to edit).
  // Empty string falls back to DEFAULT_HISTORY_TITLE on render.
  const [historyTitle, setHistoryTitle] = useState('');
  const [selectedItem, setSelectedItem] = useState<HistoryAction | null>(null);
  const [editingRemark, setEditingRemark] = useState('');
  const [savingRemark, setSavingRemark] = useState(false);
  const listRef = useRef<SectionList>(null);
  const onLatestSeenRef = useRef(onLatestSeen);
  onLatestSeenRef.current = onLatestSeen;
  const prevLatestIdRef = useRef(0);
  const myUserIdRef = useRef('');
  // Mirror myTz state into a ref so the polling closure (re-created only
  // when its useFocusEffect deps change) can always read the latest value
  // after Settings updates the user's timezone.
  const myTzRef = useRef(myTz);
  useEffect(() => { myTzRef.current = myTz; }, [myTz]);
  // Header height (measured via onLayout) drives the gradient fade strip
  // that sits right below the title — gives a soft blur edge as list items
  // scroll up into the header area instead of a hard cut.
  const [headerHeight, setHeaderHeight] = useState(0);
  // Pinned at the user's last_read_action_id when they (re)focus 废话区,
  // so the unread divider stays put even as poll updates land. Cleared by
  // useFocusEffect on each refocus → fresh divider per viewing session.
  const [boundaryId, setBoundaryId] = useState(0);
  // Gate the per-bubble entry animation: false during the very first
  // populated render (so existing history doesn't all bounce in), true after
  // — only freshly-mounted bubbles (live arrivals) play the spring.
  const initialRenderDoneRef = useRef(false);
  useEffect(() => {
    if (sections.length > 0 && !initialRenderDoneRef.current) {
      initialRenderDoneRef.current = true;
    }
  }, [sections]);
  // Two-stage divider lifecycle:
  //   dismissing  → divider still in sections, fading opacity to 0.
  //   hardHidden  → divider removed from sections entirely.
  // Reply triggers dismissing; the divider's fade callback flips hardHidden
  // afterward. Both are reset on focus to give a clean state next session.
  const [dividerDismissing, setDividerDismissing] = useState(false);
  const [dividerHardHidden, setDividerHardHidden] = useState(false);
  const visibleSections = useMemo(() => {
    if (dividerHardHidden) return sections;
    return injectUnreadDivider(sections, boundaryId, myUserId);
  }, [sections, boundaryId, myUserId, dividerHardHidden]);
  // Whether a divider is actually present in the rendered list right now —
  // used to route reply-dismiss between fade vs instant-hide. Without this,
  // setDismissing(true) when no divider is mounted would leave the flag
  // dangling, causing a future-injected divider (e.g. partner sends after
  // self reply) to mount already-fading.
  const dividerVisible = useMemo(() => {
    if (dividerHardHidden || boundaryId <= 0 || !myUserId) return false;
    for (const s of sections) {
      for (const it of s.data) {
        if (!isDivider(it) && it.id > boundaryId && it.user_id !== myUserId) return true;
      }
    }
    return false;
  }, [sections, boundaryId, myUserId, dividerHardHidden]);
  const onDividerFadeComplete = useCallback(() => {
    setDividerHardHidden(true);
    setDividerDismissing(false);
  }, []);

  // For saving remark we need current profile values
  const [myName, setMyName] = useState('');
  const [myTimezone, setMyTimezone] = useState('');
  const [myPartnerTz, setMyPartnerTz] = useState('');

  // Bottom emoji panel
  const [panelOpen, setPanelOpen] = useState(false);
  const panY = useRef(new Animated.Value(PANEL_HIDDEN)).current;
  const scrollYRef = useRef(0);
  const panelOpenRef = useRef(false);
  panelOpenRef.current = panelOpen;

  // Flip the React state immediately so the toolbar pill text ("先停停" ↔
  // "甩表情") swaps the moment the user taps. The spring still plays
  // out, but UI labels reflect intent, not animation completion.
  const closePanel = useCallback(() => {
    setPanelOpen(false);
    Animated.spring(panY, { toValue: PANEL_HIDDEN, friction: 9, tension: 80, useNativeDriver: true }).start();
  }, [panY]);

  const openPanel = useCallback(() => {
    setPanelOpen(true);
    Animated.spring(panY, { toValue: 0, friction: 9, tension: 80, useNativeDriver: true }).start();
  }, [panY]);

  const togglePanel = useCallback(() => {
    if (panelOpen) closePanel();
    else openPanel();
  }, [panelOpen, openPanel, closePanel]);

  // Toolbar pill: swipe up to peek/open the panel; tap is handled by inner TouchableOpacity.
  const toolbarPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) =>
        !panelOpenRef.current && g.dy < -5 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => {
        setPanelOpen(true);
      },
      onPanResponderMove: (_, g) => {
        if (g.dy < 0) {
          const progress = Math.min(-g.dy, PANEL_HIDDEN);
          panY.setValue(PANEL_HIDDEN - progress);
        } else {
          panY.setValue(PANEL_HIDDEN);
        }
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy < -50 || g.vy < -0.5) {
          Animated.spring(panY, { toValue: 0, friction: 9, tension: 80, useNativeDriver: true }).start();
        } else {
          setPanelOpen(false);
          Animated.spring(panY, { toValue: PANEL_HIDDEN, friction: 9, tension: 80, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  // Push the toolbar pill into the App-level overlay slot so it renders ABOVE
  // the bottom bar (and its transparent gradient). Slot is cleared on unmount.
  const toolbarSlot = useToolbarSlot();
  const { width: screenW } = useWindowDimensions();
  // All vector: bar height = pillH + paddings (each is a fraction of width),
  // plus bottom safe-area inset. Pill itself sits one "lift" above the bar.
  const barH = screenW * 0.175 + insets.bottom;
  const toolbarLift = screenW * 0.03;
  // Drive translateX from the material-top-tabs pager's animated position so
  // the pill physically slides off-screen with the History view during a
  // swipe (rather than self-fading after the swipe settles, which felt
  // detached). History is tab index 1 in App.tsx; if we reorder, update.
  const HISTORY_TAB_INDEX = 1;
  const tabAnim = useTabAnimation();
  const pillTranslateX = useMemo(
    () => Animated.multiply(
      Animated.subtract(HISTORY_TAB_INDEX, tabAnim.position),
      screenW
    ),
    [tabAnim.position, screenW]
  );
  useEffect(() => {
    toolbarSlot.set(
      <Animated.View
        style={[
          styles.toolbarRow,
          { bottom: barH + toolbarLift, transform: [{ translateX: pillTranslateX }] },
        ]}
        pointerEvents="box-none"
      >
        <View {...toolbarPanResponder.panHandlers}>
          <SpringPressable
            onPress={togglePanel}
            scaleTo={1.08}
            style={styles.toolbar}
          >
            <Text style={styles.toolbarHint}>
              {panelOpen ? '先停停 🥱' : '💌 甩表情'}
            </Text>
          </SpringPressable>
        </View>
      </Animated.View>
    );
    return () => toolbarSlot.set(null);
  }, [panelOpen, togglePanel, toolbarPanResponder, toolbarSlot, barH, toolbarLift, pillTranslateX]);

  // Capture-phase responder: when ScrollView is at top and user drags down,
  // intercept the gesture from the ScrollView and use it to close the panel.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: (_, g) => {
        return scrollYRef.current <= 0 && g.dy > 8 && g.dy > Math.abs(g.dx);
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) panY.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 80 || g.vy > 0.5) {
          setPanelOpen(false);
          Animated.spring(panY, { toValue: PANEL_HIDDEN, friction: 9, tension: 80, useNativeDriver: true }).start();
        } else {
          Animated.spring(panY, { toValue: 0, friction: 9, tension: 80, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  const scrollToBottom = useCallback(() => {
    if (sections.length === 0) return;
    setTimeout(() => {
      (listRef.current as any)?.getScrollResponder?.()?.scrollToEnd?.({ animated: false });
    }, 100);
  }, [sections]);

  const loadHistory = useCallback(async (captureBoundary: boolean = false) => {
    try {
      const userId = await storage.getUserId();
      setMyUserId(userId || '');
      myUserIdRef.current = userId || '';
      const savedTz = await storage.getTimezone();
      const savedPartnerTz = await storage.getPartnerTimezone();
      const savedRemark = await storage.getPartnerRemark();
      if (savedTz) setMyTz(savedTz);
      if (savedPartnerTz) setPartnerTz(savedPartnerTz);
      setPartnerRemark(savedRemark || '');
      const savedTitle = await storage.getHistoryTitle();
      setHistoryTitle(savedTitle || '');

      const savedName = await storage.getUserName();
      setMyName(savedName || '');
      setMyTimezone(savedTz || getDeviceTimezone());
      setMyPartnerTz(savedPartnerTz || 'Asia/Shanghai');

      // Group with the just-loaded tz (state setMyTz above hasn't settled
      // for this synchronous slice yet).
      const tz = savedTz || getDeviceTimezone();
      const result = await api.getHistory(100);
      const reversed = [...result.actions].reverse();
      // Capture BEFORE marking read so the divider sits where the user left
      // off, not at "everything read".
      if (captureBoundary) {
        setBoundaryId(result.last_read_action_id ?? 0);
      }
      setSections(groupByDate(reversed, tz));
      const latestId = reversed.length > 0 ? reversed[reversed.length - 1].id : 0;
      prevLatestIdRef.current = latestId;
      if (latestId > 0) onLatestSeenRef.current?.(latestId);
    } catch (error) {
      console.warn('Failed to load history:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Each refocus is a new viewing session — pull fresh boundary so the
      // divider lands where the user left off, not where it sat last visit.
      // Also reset divider visibility so a previously-dismissed divider can
      // appear again if there are now (newer) unread partner messages.
      setDividerDismissing(false);
      setDividerHardHidden(false);
      // Stale flag scoped to this focus session. Set to true in cleanup so
      // late-arriving fetches (started just before blur) skip their setState
      // and don't trigger "setState on unmounted" warnings or scribble over
      // a freshly-mounted next session's state.
      let stale = false;
      loadHistory(true);
      // Socket `action_new` is the primary live path; this polling exists as
      // a safety net for the case where the socket has disconnected and
      // hasn't reconnected yet. 30s is enough to feel responsive without
      // doubling up on traffic with the App-level signal.
      const interval = setInterval(async () => {
        try {
          const result = await api.getHistory(100);
          if (stale) return;
          const reversed = [...result.actions].reverse();
          const latestId = reversed.length > 0 ? reversed[reversed.length - 1].id : 0;
          if (latestId !== prevLatestIdRef.current) {
            // Polling intentionally does NOT re-capture boundary — it would
            // cause the divider to jump as new messages arrive while viewing.
            setSections(groupByDate(reversed, myTzRef.current));
            prevLatestIdRef.current = latestId;
            if (latestId > 0) onLatestSeenRef.current?.(latestId);
          }
        } catch {}
      }, 30000);
      // Live arrival via socket → refresh immediately so the new bubble
      // springs in within milliseconds (the 5s poller would otherwise hold
      // it back). Filter self so handleSendAction's own refresh isn't
      // duplicated by the same event echoed back to the sender's room.
      const unsubAction = subscribe('action_new', (data: { from?: string }) => {
        if (data?.from && data.from === myUserIdRef.current) return;
        loadHistory(false);
      });
      return () => {
        stale = true;
        clearInterval(interval);
        unsubAction();
        // Reset panel state so re-entering 废话区 always starts collapsed —
        // setValue (no animation) avoids playing a closing tween while the
        // pager is mid-transition to another tab.
        setPanelOpen(false);
        panY.setValue(PANEL_HIDDEN);
      };
    }, [loadHistory, panY])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadHistory();
  }, [loadHistory]);

  const handleSendAction = useCallback(async (actionType: string) => {
    try {
      await api.sendAction(actionType);
      // Replying = engaging with the unread thread. If the divider is on
      // screen, fade it (req 4); otherwise hard-hide directly so future
      // partner arrivals don't surface a fresh divider this session and
      // also so a stale dismissing flag doesn't make the next-mounted
      // divider auto-fade.
      if (!dividerHardHidden) {
        if (dividerVisible) setDividerDismissing(true);
        else setDividerHardHidden(true);
      }
      const result = await api.getHistory(100);
      const reversed = [...result.actions].reverse();
      setSections(groupByDate(reversed, myTzRef.current));
      const latestId = reversed.length > 0 ? reversed[reversed.length - 1].id : 0;
      prevLatestIdRef.current = latestId;
      if (latestId > 0) onLatestSeenRef.current?.(latestId);
    } catch {}
  }, [dividerVisible, dividerHardHidden]);

  const handleItemPress = useCallback((item: HistoryAction) => {
    setSelectedItem(item);
    setEditingRemark(partnerRemark);
  }, [partnerRemark]);

  const handleSaveRemark = useCallback(async () => {
    setSavingRemark(true);
    try {
      const result = await api.updateProfile(myName, myTimezone, myPartnerTz, editingRemark);
      await storage.setPartnerRemark(result.partner_remark);
      setPartnerRemark(result.partner_remark);
      setSelectedItem(null);
    } catch (error: any) {
      Alert.alert('保存失败', error.message);
    } finally {
      setSavingRemark(false);
    }
  }, [myName, myTimezone, myPartnerTz, editingRemark]);

  // v1.2.20 — long-press the 废话区 header title to rename it. Saves
  // server-side via PUT /api/profile (history_title field). Empty
  // input is normalised to '' (server-side trim), which the renderer
  // falls back to '香宝聚集地 💕' for. Account-scoped, persists across
  // logout / reinstall (server is the source of truth; storage cache
  // re-hydrates on next bootstrap getStatus).
  const promptEditHistoryTitle = useCallback(() => {
    Alert.prompt(
      '修改废话区标题',
      `最多 ${HISTORY_TITLE_MAX_CHARS} 个字符。留空恢复默认。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '保存',
          onPress: async (raw?: string) => {
            const next = (raw ?? '').trim().slice(0, HISTORY_TITLE_MAX_CHARS);
            if (next === historyTitle.trim()) return;
            try {
              const result = await api.updateProfile(
                myName, myTimezone, myPartnerTz, partnerRemark, next,
              );
              setHistoryTitle(result.history_title);
              await storage.setHistoryTitle(result.history_title);
            } catch (e: any) {
              Alert.alert('', e?.message || '保存失败');
            }
          },
        },
      ],
      'plain-text',
      historyTitle,
    );
  }, [historyTitle, myName, myTimezone, myPartnerTz, partnerRemark]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.kiss} />
      </View>
    );
  }

  const selectedIsMine = selectedItem ? selectedItem.user_id === myUserId : false;
  const selectedTz = selectedItem
    ? (selectedIsMine ? myTz : partnerTz)
    : '';
  const selectedTzLabel = TIMEZONE_LABELS[selectedTz] || selectedTz;

  return (
    <View style={styles.container}>
      <View
        style={[styles.header, { paddingTop: insets.top + 12 }]}
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
      >
        <Text
          style={styles.headerTitle}
          onLongPress={promptEditHistoryTitle}
          suppressHighlighting
        >
          {(historyTitle && historyTitle.trim()) || DEFAULT_HISTORY_TITLE}
        </Text>
        <Text style={styles.headerSubtitle}>与 {partnerName} 已连接</Text>
      </View>

      <SectionList
        ref={listRef}
        sections={visibleSections}
        keyExtractor={(item) => isDivider(item) ? 'divider' : item.id.toString()}
        onContentSizeChange={scrollToBottom}
        renderItem={({ item }) => {
          if (isDivider(item)) {
            return (
              <UnreadDivider
                dismissed={dividerDismissing}
                onFadeComplete={onDividerFadeComplete}
              />
            );
          }
          const isMine = item.user_id === myUserId;
          // For burst-collapsed groups (v1.2.20), show the LATEST member's
          // wall-clock time — "ta sent this most recently at HH:MM".
          // Falls back to created_at for legacy / singleton items.
          const stamp = (item as GroupedAction).displayCreatedAt ?? item.created_at;
          const myTime = formatTimeInZone(stamp, myTz);
          const pTime = !isMine ? formatTimeInZone(stamp, partnerTz) : undefined;
          return (
            <ActionRecord
              userName={item.user_name}
              actionType={item.action_type}
              time={myTime}
              partnerTime={pTime}
              isMine={isMine}
              remark={!isMine ? partnerRemark : undefined}
              onPress={() => handleItemPress(item)}
              animateOnMount={initialRenderDoneRef.current}
              count={(item as GroupedAction).count}
            />
          );
        }}
        renderSectionHeader={({ section: { title } }) => (
          <Text style={styles.sectionHeader}>{title}</Text>
        )}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.kiss} />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>还没有记录，快去按按钮吧～</Text>
          </View>
        }
        contentContainerStyle={
          sections.length === 0
            ? styles.emptyContainer
            : [styles.list, { paddingBottom: TOOLBAR_HEIGHT + 16 }]
        }
        stickySectionHeadersEnabled={false}
      />

      {/* Soft fade between title bar and feed: from solid bg at the title
          edge to fully transparent below. Items scrolling up into this strip
          fade out into the header instead of meeting a hard cut. */}
      {headerHeight > 0 && (
        <LinearGradient
          colors={[COLORS.background, 'rgba(255, 245, 245, 0)']}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: headerHeight,
            height: 24,
          }}
          pointerEvents="none"
        />
      )}

      {panelOpen && (
        <Pressable
          style={[styles.tapToClose, { bottom: TOOLBAR_HEIGHT + PANEL_HEIGHT }]}
          onPress={closePanel}
        />
      )}

      {selectedItem && (
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setSelectedItem(null)}>
          <TouchableOpacity style={styles.modalContent} activeOpacity={1}>
            <View style={styles.modalBody}>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>表情</Text>
                <Text style={styles.detailValue}>
                  {ACTION_EMOJI[selectedItem.action_type] || '?'}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>昵称</Text>
                <Text style={styles.detailValue}>{selectedItem.user_name}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>时区</Text>
                <Text style={styles.detailValue}>{selectedTzLabel}</Text>
              </View>

              {!selectedIsMine && (
                <>
                  <Text style={styles.remarkLabel}>备注</Text>
                  <TextInput
                    style={styles.remarkInput}
                    value={editingRemark}
                    onChangeText={setEditingRemark}
                    placeholder="给 ta 起个备注"
                    placeholderTextColor={COLORS.textLight}
                    maxLength={20}
                  />
                  <TouchableOpacity
                    style={[styles.saveButton, savingRemark && styles.saveButtonDisabled]}
                    onPress={handleSaveRemark}
                    disabled={savingRemark}
                  >
                    <Text style={styles.saveButtonText}>
                      {savingRemark ? '保存中...' : '保存备注'}
                    </Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      <Animated.View
        pointerEvents={panelOpen ? 'auto' : 'none'}
        style={[styles.panel, { transform: [{ translateY: panY }] }]}
        {...panResponder.panHandlers}
      >
        <View style={styles.dragHandleArea}>
          <View style={styles.dragHandle} />
        </View>
        <ScrollView
          onScroll={(e) => { scrollYRef.current = e.nativeEvent.contentOffset.y; }}
          scrollEventThrottle={16}
          contentContainerStyle={styles.panelContent}
          showsVerticalScrollIndicator={false}
        >
          {ACTION_CATEGORIES.map((category) => {
            const rows = chunkArray(category.actions, COLUMNS);
            return (
              <View key={category.title} style={styles.categoryBlock}>
                <Text style={styles.categoryTitle}>{category.title}</Text>
                {rows.map((row, ri) => {
                  const isLast = ri === rows.length - 1;
                  const padTotal = COLUMNS - row.length;
                  // Center the last partial row when category opts in (e.g. "找你"),
                  // otherwise pad on the right so earlier rows stay left-aligned.
                  const padLeft = isLast && category.centerLastRow ? Math.floor(padTotal / 2) : 0;
                  const padRight = padTotal - padLeft;
                  return (
                    <View key={ri} style={styles.gridRow}>
                      {Array.from({ length: padLeft }).map((_, i) => (
                        <View key={`padL-${i}`} style={styles.gridCell} />
                      ))}
                      {row.map((action) => (
                        <View key={action.type} style={styles.gridCell}>
                          <CompactActionButton
                            action={action}
                            onPress={handleSendAction}
                          />
                        </View>
                      ))}
                      {Array.from({ length: padRight }).map((_, i) => (
                        <View key={`padR-${i}`} style={styles.gridCell} />
                      ))}
                    </View>
                  );
                })}
              </View>
            );
          })}
        </ScrollView>
      </Animated.View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    alignItems: 'center',
    backgroundColor: COLORS.background,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.text,
  },
  headerSubtitle: {
    fontSize: 13,
    color: COLORS.textLight,
    marginTop: 4,
  },
  list: {
    paddingTop: 8,
    paddingBottom: 24,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
  },
  emptyContainer: {
    flexGrow: 1,
  },
  sectionHeader: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textLight,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  emptyText: {
    fontSize: 16,
    color: COLORS.textLight,
  },
  tapToClose: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'transparent',
    zIndex: 50,
  },
  panel: {
    position: 'absolute',
    // Float-with-margins so the panel reads as a single rounded "island"
    // hovering over the chat list rather than a full-width drawer.
    left: 12,
    right: 12,
    bottom: TOOLBAR_HEIGHT,
    height: PANEL_HEIGHT,
    backgroundColor: 'rgba(255, 255, 255, 0.75)',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.6)',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
    overflow: 'hidden',
    zIndex: 60,
  },
  dragHandleArea: {
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.border,
  },
  panelContent: {
    paddingHorizontal: PANEL_PADDING_X,
    paddingBottom: 12,
  },
  categoryBlock: {
    marginBottom: 4,
  },
  categoryTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textLight,
    marginBottom: 8,
    marginLeft: 2,
  },
  gridRow: {
    flexDirection: 'row',
    gap: COL_GAP,
    marginBottom: ROW_GAP,
  },
  gridCell: {
    flex: 1,
    aspectRatio: 1,
  },
  compactWrapper: {
    width: '100%',
    height: '100%',
  },
  compactButton: {
    width: '100%',
    height: '100%',
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  compactEmoji: {
    fontSize: 22,
    marginBottom: 2,
  },
  compactLabel: {
    fontSize: 10,
    fontWeight: '500',
    color: COLORS.text,
    paddingHorizontal: 2,
  },
  toolbarRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    zIndex: 70,
  },
  toolbar: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 26,
    backgroundColor: COLORS.kiss,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 8,
  },
  toolbarHint: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    width: '72%',
    maxWidth: 300,
    paddingBottom: 16,
  },
  modalBody: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  detailLabel: {
    fontSize: 15,
    color: COLORS.textLight,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: '500',
    color: COLORS.text,
  },
  remarkLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textLight,
    marginTop: 16,
    marginBottom: 8,
  },
  remarkInput: {
    height: 44,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  saveButton: {
    height: 44,
    backgroundColor: COLORS.kiss,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 12,
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.white,
  },
});
