import React, { useCallback, useEffect, useState, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import {
  Modal,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Image,
  Dimensions,
  Pressable,
  Animated,
  Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, API_URL } from '../constants';
import { api, SnapMonth } from '../services/api';
import { SpringPressable } from '../components/SpringPressable';

// v1.2.21 — "快照日历": mailbox-side entry that opens a per-month grid of
// daily snap photos. Mirrors StickyWall / Inbox / Trash modal pattern
// (pageSheet, 收起 pill at bottom) so it slots into MailboxScreen's
// existing entry-card rhythm.
//
// Content is read-only: every cell is either empty (no snap that day),
// a single polaroid thumbnail (one partner snapped, anti-peek rules
// enforced server-side), or a two-photo composite (both snapped). Tap
// a cell with content to enlarge.

const SCREEN_W = Dimensions.get('window').width;
// 7-column calendar: cells are squareish. Outer padding 16 each side +
// gap 4 between cells × 6 = 24. Total horizontal slack = 56.
const HORIZONTAL_PADDING = 16;
const CELL_GAP = 4;
const CELL_SIZE = Math.floor((SCREEN_W - HORIZONTAL_PADDING * 2 - CELL_GAP * 6) / 7);

// v1.3.2 — ta｜我 toggle dimensions (bottom-right segmented control).
const TOGGLE_SEG_WIDTH = 40;
const TOGGLE_HEIGHT = 32;
const TOGGLE_PADDING = 4;
// Mirror sticky-wall partner ink color so "ta" mode reads visually
// distinct from "me" (which uses the brand pink).
const PARTNER_ACCENT = '#7AB8D6';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export interface SnapCalendarHandle {
  reload: () => Promise<void>;
}

// Sunday-first to match the iOS Calendar default in zh-CN.
const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  // m is 1-12. JS Date month is 0-11. Build then read back.
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
}

function buildGrid(monthYYYYMM: string): Array<{ day: number; dateKey: string } | null> {
  // Pre-render-friendly: returns 42 cells (6 rows × 7), with nulls for
  // leading/trailing padding. Caller renders nulls as empty placeholders.
  const [y, m] = monthYYYYMM.split('-').map(Number);
  const firstDay = new Date(y, m - 1, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells: Array<{ day: number; dateKey: string } | null> = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, dateKey: `${y}-${pad2(m)}-${pad2(d)}` });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  // Always end at a full row; capped at 6 rows (= 42 cells) — months
  // never need more than 6 rows.
  while (cells.length < 42) cells.push(null);
  return cells.slice(0, 42);
}

const SnapCalendarScreen = forwardRef<SnapCalendarHandle, Props>(({ visible, onClose }, ref) => {
  const insets = useSafeAreaInsets();
  const today = useMemo(() => new Date(), []);
  const [currentMonth, setCurrentMonth] = useState<string>(monthKey(today));
  const [snaps, setSnaps] = useState<SnapMonth[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<SnapMonth | null>(null);
  // v1.3.2 — ta | 我 segmented filter. Default 'me' so users start
  // with their own photos. Persists across this modal's open/close
  // because the parent (MailboxScreen) keeps the component mounted;
  // resets to 'me' on app cold start.
  const [viewMode, setViewMode] = useState<'ta' | 'me'>('me');
  // Indicator slide animation. 0 ⇒ "ta" segment selected, 1 ⇒ "me".
  // useNativeDriver via translateX keeps the slide jank-free.
  const indicatorAnim = useRef(new Animated.Value(viewMode === 'ta' ? 0 : 1)).current;
  useEffect(() => {
    Animated.spring(indicatorAnim, {
      toValue: viewMode === 'ta' ? 0 : 1,
      friction: 7,
      tension: 80,
      useNativeDriver: true,
    }).start();
  }, [viewMode, indicatorAnim]);

  // Map<dateKey, SnapMonth> for O(1) lookup during cell render. Re-derives
  // only when the source array changes.
  const byDate = useMemo(() => {
    const map = new Map<string, SnapMonth>();
    for (const s of snaps) map.set(s.date, s);
    return map;
  }, [snaps]);

  const load = useCallback(async (month: string, opts: { showSpinner: boolean } = { showSpinner: true }) => {
    if (opts.showSpinner) setLoading(true);
    try {
      const res = await api.getSnaps(month).catch(() => ({ snaps: [] as SnapMonth[] }));
      setSnaps(res.snaps || []);
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-fetch on every (visible, month) transition. Stale flag guards
  // against close-then-reopen races where an in-flight fetch could
  // overwrite a fresh load.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    api.getSnaps(currentMonth)
      .then((res) => {
        if (cancelled) return;
        setSnaps(res.snaps || []);
      })
      .catch(() => {
        if (cancelled) return;
        setSnaps([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [visible, currentMonth]);

  // Reset to current month every time the modal opens, so coming back
  // after a long pause doesn't strand the user on a stale month.
  useEffect(() => {
    if (visible) {
      setCurrentMonth(monthKey(new Date()));
      setExpanded(null);
    }
  }, [visible]);

  useImperativeHandle(ref, () => ({
    reload: () => load(currentMonth, { showSpinner: false }),
  }), [load, currentMonth]);

  const grid = useMemo(() => buildGrid(currentMonth), [currentMonth]);
  const monthLabel = useMemo(() => {
    const [y, m] = currentMonth.split('-').map(Number);
    return `${y} 年 ${m} 月`;
  }, [currentMonth]);

  const onPrev = useCallback(() => {
    Haptics.selectionAsync();
    setCurrentMonth((m) => shiftMonth(m, -1));
  }, []);
  const onNext = useCallback(() => {
    Haptics.selectionAsync();
    setCurrentMonth((m) => shiftMonth(m, 1));
  }, []);

  const onCellTap = useCallback((snap: SnapMonth | undefined) => {
    if (!snap || (!snap.my_photo && !snap.partner_photo)) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpanded(snap);
  }, []);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
    >
      <View style={[styles.container, { paddingTop: 24 }]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>📷 快照日历</Text>
        </View>

        {/* Month switcher — same visual rhythm as the half-day reveal
            pill below the 写信 button in MailboxScreen. */}
        <View style={styles.monthSwitcher}>
          <TouchableOpacity onPress={onPrev} style={styles.arrowBtn} hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}>
            <Text style={styles.arrowText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.monthLabel}>{monthLabel}</Text>
          <TouchableOpacity onPress={onNext} style={styles.arrowBtn} hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}>
            <Text style={styles.arrowText}>›</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.weekRow}>
          {WEEK_LABELS.map((w) => (
            <View key={w} style={styles.weekCell}>
              <Text style={styles.weekText}>{w}</Text>
            </View>
          ))}
        </View>

        {loading ? (
          <View style={styles.centerLoading}>
            <ActivityIndicator color={COLORS.kiss} />
          </View>
        ) : (
          // v1.3.1 — Pressable around the scroll body lets a tap on any
          // empty area (gap between cells, padding around the grid,
          // bottom slack) dismiss the modal — same convention as the
          // Inbox listWrap Pressable. Scroll gestures still belong to
          // the ScrollView (RN GestureResponder prioritises drag), and
          // tap on a cell is consumed by the cell's TouchableOpacity
          // before reaching here.
          <Pressable style={styles.gridArea} onPress={onClose}>
            <ScrollView
              contentContainerStyle={[
                styles.grid,
                // Padding bottom keeps the last row clear of the 收起 pill.
                { paddingBottom: insets.bottom + 80 },
              ]}
              showsVerticalScrollIndicator={false}
            >
              {grid.map((cell, idx) => {
                if (!cell) {
                  return <View key={`pad-${idx}`} style={styles.cellEmpty} />;
                }
                const snap = byDate.get(cell.dateKey);
                // v1.3.2 — filter by the current ta/me toggle. Anti-peek
                // is still enforced server-side (partner_photo=null when
                // I haven't snapped that day), so a "ta" cell where I
                // never snapped is naturally empty.
                const visiblePhoto =
                  viewMode === 'me' ? snap?.my_photo : snap?.partner_photo;
                const hasVisible = !!visiblePhoto;
                const isToday =
                  cell.dateKey ===
                  `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
                return (
                  <TouchableOpacity
                    key={cell.dateKey}
                    activeOpacity={hasVisible ? 0.7 : 1}
                    onPress={() => hasVisible && snap && onCellTap(snap)}
                    style={[styles.cell, isToday && styles.cellToday]}
                  >
                    {hasVisible ? (
                      <PolaroidThumb
                        photoUri={visiblePhoto!}
                        dayLabel={cell.day}
                        accent={viewMode === 'me' ? COLORS.kiss : PARTNER_ACCENT}
                      />
                    ) : (
                      <View style={styles.cellPlain}>
                        <Text style={[styles.dayText, isToday && styles.dayTextToday]}>{cell.day}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}

              {snaps.length === 0 && !loading && (
                <Text style={styles.emptyHint}>这个月还没有快照～</Text>
              )}
            </ScrollView>
          </Pressable>
        )}

        {/* Title-edge soft fade — mirrors InboxScreen so cards sliding up
            into the title bar dissolve smoothly. */}
        <LinearGradient
          colors={[COLORS.background, 'rgba(255, 245, 245, 0)']}
          style={styles.titleEdgeFade}
          pointerEvents="none"
        />

        {/* "收起" pill — same dismiss affordance shape as Inbox / Trash /
            StickyWall modals. */}
        <View style={[styles.pillSlot, { paddingBottom: insets.bottom + 16 }]} pointerEvents="box-none">
          <SpringPressable onPress={onClose} style={styles.dismissPill} scaleTo={1.06}>
            <Text style={styles.dismissPillText}>收起</Text>
          </SpringPressable>
        </View>

        {/* v1.3.2 — ta｜我 segmented control floats at the bottom-right
            on the same row as the 收起 pill. Tapping a segment swaps
            which photo each cell renders; the indicator pill slides
            between segments with a spring (translateX, useNativeDriver
            for smoothness). */}
        <View style={[styles.toggleSlot, { bottom: insets.bottom + 16 }]} pointerEvents="box-none">
          <View style={styles.toggleContainer}>
            <Animated.View
              style={[
                styles.toggleIndicator,
                {
                  transform: [
                    {
                      translateX: indicatorAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, TOGGLE_SEG_WIDTH],
                      }),
                    },
                  ],
                },
              ]}
            />
            <TouchableOpacity
              style={styles.toggleSegment}
              activeOpacity={0.7}
              onPress={() => {
                Haptics.selectionAsync();
                setViewMode('ta');
              }}
            >
              <Text style={[styles.toggleText, viewMode === 'ta' && styles.toggleTextActive]}>ta</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.toggleSegment}
              activeOpacity={0.7}
              onPress={() => {
                Haptics.selectionAsync();
                setViewMode('me');
              }}
            >
              <Text style={[styles.toggleText, viewMode === 'me' && styles.toggleTextActive]}>我</Text>
            </TouchableOpacity>
          </View>
        </View>

        <SnapPreviewOverlay
          snap={expanded}
          viewMode={viewMode}
          onClose={() => setExpanded(null)}
        />
      </View>
    </Modal>
  );
});

export default SnapCalendarScreen;

// v1.3.2 — single-photo polaroid (post ta/me toggle). The accent strip
// at the bottom is pink for "me" mode, blue for "ta" mode, mirroring
// the sticky-wall double-color convention so a quick glance is enough
// to tell whose photo this is.
function PolaroidThumb({
  photoUri,
  dayLabel,
  accent,
}: {
  photoUri: string;
  dayLabel: number;
  accent: string;
}) {
  return (
    <View style={polaroidStyles.wrap}>
      <Image
        source={{ uri: `${API_URL}${photoUri}` }}
        style={[polaroidStyles.single, polaroidStyles.frame]}
        resizeMode="cover"
      />
      <View style={[polaroidStyles.accentStripe, { backgroundColor: accent }]} />
      <View style={polaroidStyles.dayPill}>
        <Text style={polaroidStyles.dayPillText}>{dayLabel}</Text>
      </View>
    </View>
  );
}

// Full-screen overlay shown when the user taps a cell with a snap. Tap
// the dim background to close. v1.3.2 — also respects the ta/me toggle:
// shows only the current mode's photo, so what the user clicked in the
// grid is what they see expanded.
function SnapPreviewOverlay({
  snap,
  viewMode,
  onClose,
}: {
  snap: SnapMonth | null;
  viewMode: 'ta' | 'me';
  onClose: () => void;
}) {
  const opacity = React.useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (snap) {
      Animated.timing(opacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    } else {
      opacity.setValue(0);
    }
  }, [snap, opacity]);

  if (!snap) return null;
  const path = viewMode === 'me' ? snap.my_photo : snap.partner_photo;
  if (!path) return null;
  return (
    <Animated.View style={[overlayStyles.backdrop, { opacity }]} pointerEvents="auto">
      <Pressable style={overlayStyles.dismissArea} onPress={onClose}>
        <View style={overlayStyles.center}>
          <Text style={overlayStyles.dateLabel}>{snap.date}</Text>
          <Image source={{ uri: `${API_URL}${path}` }} style={overlayStyles.photo} resizeMode="contain" />
          <Text style={overlayStyles.hint}>点击空白处收起</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.text,
  },
  monthSwitcher: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    gap: 24,
  },
  arrowBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  arrowText: {
    fontSize: 24,
    color: COLORS.kiss,
    fontWeight: '700',
  },
  monthLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
    minWidth: 110,
    textAlign: 'center',
  },
  weekRow: {
    flexDirection: 'row',
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingBottom: 6,
  },
  weekCell: {
    flex: 1,
    alignItems: 'center',
  },
  weekText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textLight,
  },
  // v1.3.1 — Pressable that wraps the scrollable grid; tap-on-empty
  // closes the modal (cells consume their own onPress, scroll gestures
  // belong to the inner ScrollView).
  gridArea: {
    flex: 1,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: HORIZONTAL_PADDING,
    gap: CELL_GAP,
  },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE + 8,
    borderRadius: 8,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  cellEmpty: {
    width: CELL_SIZE,
    height: CELL_SIZE + 8,
  },
  cellToday: {
    borderColor: COLORS.kiss,
    borderWidth: 1.5,
  },
  cellPlain: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: {
    fontSize: 13,
    color: COLORS.textLight,
    fontWeight: '500',
  },
  dayTextToday: {
    color: COLORS.kiss,
    fontWeight: '700',
  },
  centerLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyHint: {
    width: '100%',
    textAlign: 'center',
    fontSize: 12,
    color: COLORS.textLight,
    marginTop: 24,
  },
  titleEdgeFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 64,
    height: 16,
  },
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
  // v1.3.2 — ta｜我 toggle (bottom-right, same row as the 收起 pill).
  toggleSlot: {
    position: 'absolute',
    right: 20,
    alignItems: 'flex-end',
  },
  toggleContainer: {
    flexDirection: 'row',
    width: TOGGLE_SEG_WIDTH * 2 + TOGGLE_PADDING * 2,
    height: TOGGLE_HEIGHT,
    borderRadius: TOGGLE_HEIGHT / 2,
    backgroundColor: '#F0EBE5',
    padding: TOGGLE_PADDING,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 4,
  },
  toggleIndicator: {
    position: 'absolute',
    top: TOGGLE_PADDING,
    left: TOGGLE_PADDING,
    width: TOGGLE_SEG_WIDTH,
    height: TOGGLE_HEIGHT - TOGGLE_PADDING * 2,
    borderRadius: (TOGGLE_HEIGHT - TOGGLE_PADDING * 2) / 2,
    backgroundColor: COLORS.kiss,
  },
  toggleSegment: {
    width: TOGGLE_SEG_WIDTH,
    height: TOGGLE_HEIGHT - TOGGLE_PADDING * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.text,
  },
  toggleTextActive: {
    color: COLORS.white,
  },
});

const polaroidStyles = StyleSheet.create({
  wrap: {
    flex: 1,
    padding: 2,
  },
  frame: {
    position: 'absolute',
    backgroundColor: COLORS.white,
    borderRadius: 3,
  },
  // v1.3.2 — single-photo polaroid sized to fill the cell minus a tiny
  // breathing border (so the frame edge reads as a polaroid border).
  single: {
    top: 2,
    left: 2,
    right: 2,
    bottom: 6, // leave a slim strip at the bottom for the accent bar
  },
  // Author color: pink for "me" mode, blue for "ta" mode. Mirrors the
  // sticky-wall double-color convention.
  accentStripe: {
    position: 'absolute',
    left: 2,
    right: 2,
    bottom: 2,
    height: 3,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
  },
  dayPill: {
    position: 'absolute',
    top: 2,
    right: 2,
    paddingHorizontal: 4,
    paddingVertical: 1,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 6,
  },
  dayPillText: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.text,
  },
});

const overlayStyles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissArea: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    width: '90%',
    alignItems: 'center',
    gap: 12,
  },
  dateLabel: {
    color: COLORS.white,
    fontSize: 18,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  photo: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 12,
    backgroundColor: '#222',
  },
  hint: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginTop: 8,
  },
});
