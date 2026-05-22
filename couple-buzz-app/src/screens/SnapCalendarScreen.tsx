import React, { useCallback, useEffect, useState, useMemo, forwardRef, useImperativeHandle } from 'react';
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
                const hasAny = !!snap && (!!snap.my_photo || !!snap.partner_photo);
                const isToday =
                  cell.dateKey ===
                  `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
                return (
                  <TouchableOpacity
                    key={cell.dateKey}
                    activeOpacity={hasAny ? 0.7 : 1}
                    onPress={() => onCellTap(snap)}
                    style={[styles.cell, isToday && styles.cellToday]}
                  >
                    {hasAny ? (
                      <PolaroidThumb snap={snap!} dayLabel={cell.day} />
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

        <SnapPreviewOverlay snap={expanded} onClose={() => setExpanded(null)} />
      </View>
    </Modal>
  );
});

export default SnapCalendarScreen;

// Renders a single cell's photo content. One snap = one polaroid; both
// snaps = two polaroids slightly offset, mine on top.
function PolaroidThumb({ snap, dayLabel }: { snap: SnapMonth; dayLabel: number }) {
  const mineUri = snap.my_photo ? `${API_URL}${snap.my_photo}` : null;
  const partnerUri = snap.partner_photo ? `${API_URL}${snap.partner_photo}` : null;
  return (
    <View style={polaroidStyles.wrap}>
      {partnerUri && (
        <Image
          source={{ uri: partnerUri }}
          style={[polaroidStyles.partner, polaroidStyles.frame]}
          resizeMode="cover"
        />
      )}
      {mineUri && (
        <Image
          source={{ uri: mineUri }}
          style={[
            polaroidStyles.mine,
            polaroidStyles.frame,
            // When ta also snapped, mine sits offset on top with a tilt.
            partnerUri ? polaroidStyles.mineOverlap : null,
          ]}
          resizeMode="cover"
        />
      )}
      <View style={polaroidStyles.dayPill}>
        <Text style={polaroidStyles.dayPillText}>{dayLabel}</Text>
      </View>
    </View>
  );
}

// Full-screen overlay shown when the user taps a cell with a snap. Tap
// the dim background to close.
function SnapPreviewOverlay({ snap, onClose }: { snap: SnapMonth | null; onClose: () => void }) {
  const opacity = React.useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (snap) {
      Animated.timing(opacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    } else {
      opacity.setValue(0);
    }
  }, [snap, opacity]);

  if (!snap) return null;
  const mineUri = snap.my_photo ? `${API_URL}${snap.my_photo}` : null;
  const partnerUri = snap.partner_photo ? `${API_URL}${snap.partner_photo}` : null;
  return (
    <Animated.View style={[overlayStyles.backdrop, { opacity }]} pointerEvents="auto">
      <Pressable style={overlayStyles.dismissArea} onPress={onClose}>
        <View style={overlayStyles.center}>
          <Text style={overlayStyles.dateLabel}>{snap.date}</Text>
          <View style={overlayStyles.photoStack}>
            {mineUri && (
              <Image source={{ uri: mineUri }} style={overlayStyles.photo} resizeMode="contain" />
            )}
            {partnerUri && (
              <Image source={{ uri: partnerUri }} style={overlayStyles.photo} resizeMode="contain" />
            )}
          </View>
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
  partner: {
    top: 4,
    left: 4,
    right: 10,
    bottom: 10,
    transform: [{ rotate: '-2deg' }],
  },
  mine: {
    top: 4,
    left: 4,
    right: 4,
    bottom: 4,
  },
  mineOverlap: {
    top: 8,
    left: 10,
    right: 4,
    bottom: 6,
    transform: [{ rotate: '2deg' }],
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
  photoStack: {
    width: '100%',
    gap: 12,
    alignItems: 'center',
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
