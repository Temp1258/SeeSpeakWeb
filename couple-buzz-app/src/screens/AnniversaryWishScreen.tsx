import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  Modal,
  FlatList,
  RefreshControl,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../constants';
import { api, ImportantDate } from '../services/api';
import BucketListCard from '../components/BucketListCard';
import FireworksOverlay, { FireworksHandle } from '../components/FireworksOverlay';
import { SpringPressable } from '../components/SpringPressable';

type Reloadable = { reload: () => Promise<void> };

export default function AnniversaryWishScreen() {
  const insets = useSafeAreaInsets();

  const [dates, setDates] = useState<ImportantDate[]>([]);
  const [newDateTitle, setNewDateTitle] = useState('');
  const [newDateRecurring, setNewDateRecurring] = useState(false);
  const [showAddDate, setShowAddDate] = useState(false);
  // v1.3.7 — null = 添加模式; ImportantDate = 编辑模式 (existing row being
  // updated). Drives the form's submit branch (POST vs PUT) and the
  // 添加 / 保存 label swap. PUT /dates/:id has always existed server-side;
  // the client just hadn't surfaced an entry point.
  const [editingDate, setEditingDate] = useState<ImportantDate | null>(null);

  const todayInit = new Date();
  const [pickYear, setPickYear] = useState(todayInit.getFullYear());
  const [pickMonth, setPickMonth] = useState(todayInit.getMonth() + 1);
  const [pickDay, setPickDay] = useState(todayInit.getDate());
  const [datePart, setDatePart] = useState<'year' | 'month' | 'day' | null>(null);

  const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
  const clampDay = (y: number, m: number, d: number) => Math.min(d, daysInMonth(y, m));

  const composedDate = `${pickYear}-${String(pickMonth).padStart(2, '0')}-${String(clampDay(pickYear, pickMonth, pickDay)).padStart(2, '0')}`;

  const loadDates = useCallback(async () => {
    try {
      const result = await api.getDates();
      setDates(result.dates);
    } catch {}
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const bucketRef = useRef<Reloadable>(null);
  const fireworksRef = useRef<FireworksHandle>(null);
  // Scroll-bound fade — see UsScreen.
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
        loadDates(),
        bucketRef.current?.reload(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [loadDates]);

  useFocusEffect(
    useCallback(() => {
      loadDates();
    }, [loadDates])
  );

  // Pulls form state back to add-mode defaults. Used both by 取消 and
  // after a successful save so the next 添加纪念日 tap opens fresh.
  const closeDateForm = () => {
    setShowAddDate(false);
    setEditingDate(null);
    setNewDateTitle('');
    setNewDateRecurring(false);
  };

  const handleStartEdit = (d: ImportantDate) => {
    // "YYYY-MM-DD" → numeric year/month/day for the existing 3-segment picker.
    // The same picker handles both add and edit; pre-seeding it here keeps
    // the UX identical to the add flow.
    const parts = d.date.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const day = Number(parts[2]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(day)) return;
    setEditingDate(d);
    setNewDateTitle(d.title);
    // `recurring` lands here as 0/1 from SQLite; the local form state is
    // boolean. Coerce so the checkbox label flips correctly on edit.
    setNewDateRecurring(!!d.recurring);
    setPickYear(y);
    setPickMonth(m);
    setPickDay(day);
    setShowAddDate(true);
  };

  const handleSaveDate = async () => {
    const title = newDateTitle.trim();
    if (!title) { Alert.alert('', '请输入标题'); return; }
    try {
      if (editingDate) {
        await api.updateDate(editingDate.id, title, composedDate, newDateRecurring);
      } else {
        await api.createDate(title, composedDate, newDateRecurring);
      }
      closeDateForm();
      loadDates();
    } catch (e: any) {
      Alert.alert(editingDate ? '保存失败' : '添加失败', e.message);
    }
  };

  const handlePinDate = async (id: number) => {
    try {
      await api.pinDate(id);
      loadDates();
    } catch {}
  };

  const handleDeleteDate = (id: number, title: string) => {
    Alert.alert('删除纪念日', `确定删除"${title}"？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive', onPress: async () => {
          try { await api.deleteDate(id); loadDates(); } catch {}
        },
      },
    ]);
  };

  const handleCelebrate = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    fireworksRef.current?.fire();
  }, []);

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <Animated.ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.kiss} />
        }
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
        scrollEventThrottle={16}
      >
        <Text style={styles.sectionTitle}>纪念日</Text>
        {dates.map((d) => (
          <View key={d.id} style={[styles.dateRow, d.pinned ? styles.dateRowPinned : null]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.dateTitle}>
                {d.pinned ? '📌 ' : ''}{d.title}{d.recurring ? ' 🔁' : ''}
              </Text>
              <Text style={styles.dateValue}>{d.date}</Text>
            </View>
            <TouchableOpacity
              style={[styles.pinBtn, d.pinned ? styles.pinBtnActive : undefined]}
              onPress={() => handlePinDate(d.id)}
            >
              <Text style={[styles.pinBtnText, d.pinned ? styles.pinBtnTextActive : undefined]}>
                {d.pinned ? '已置顶' : '置顶'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => handleStartEdit(d)}>
              <Text style={styles.dateEdit}>编辑</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => handleDeleteDate(d.id, d.title)}>
              <Text style={styles.dateDelete}>删除</Text>
            </TouchableOpacity>
          </View>
        ))}

        {showAddDate ? (
          <View style={styles.addDateForm}>
            <TextInput
              style={styles.input}
              value={newDateTitle}
              onChangeText={setNewDateTitle}
              placeholder="标题（如：纪念日）"
              placeholderTextColor={COLORS.textLight}
              maxLength={20}
            />
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
                <Text style={styles.dpValue}>{clampDay(pickYear, pickMonth, pickDay)}</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.calSelected}>已选: {composedDate}</Text>
            <TouchableOpacity
              style={styles.recurringToggle}
              onPress={() => setNewDateRecurring(!newDateRecurring)}
            >
              <Text style={styles.recurringText}>
                {newDateRecurring ? '✅ 每年重复' : '⬜ 每年重复'}
              </Text>
            </TouchableOpacity>
            <View style={styles.addDateActions}>
              <TouchableOpacity style={styles.addDateCancel} onPress={closeDateForm}>
                <Text style={styles.addDateCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.addDateConfirm} onPress={handleSaveDate}>
                <Text style={styles.addDateConfirmText}>{editingDate ? '保存' : '添加'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.addPillContainer}>
            <SpringPressable
              onPress={() => setShowAddDate(true)}
              scaleTo={1.08}
              style={styles.addPill}
            >
              <Text style={styles.addPillText}>添加纪念日</Text>
            </SpringPressable>
          </View>
        )}

        <View style={{ height: 24 }} />
        <BucketListCard ref={bucketRef} onCelebrate={handleCelebrate} />
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

      <Modal visible={datePart !== null} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {datePart === 'year' ? '选择年份' : datePart === 'month' ? '选择月份' : '选择日'}
              </Text>
              <TouchableOpacity onPress={() => setDatePart(null)}>
                <Text style={styles.modalClose}>完成</Text>
              </TouchableOpacity>
            </View>
            {datePart && (
              <FlatList
                data={(() => {
                  if (datePart === 'year') {
                    const cur = new Date().getFullYear();
                    return Array.from({ length: cur + 10 - 1900 + 1 }, (_, i) => 1900 + i).reverse();
                  }
                  if (datePart === 'month') {
                    return Array.from({ length: 12 }, (_, i) => i + 1);
                  }
                  return Array.from({ length: daysInMonth(pickYear, pickMonth) }, (_, i) => i + 1);
                })()}
                keyExtractor={(item) => String(item)}
                initialScrollIndex={(() => {
                  if (datePart === 'year') {
                    const cur = new Date().getFullYear();
                    return Math.max(0, (cur + 10) - pickYear);
                  }
                  if (datePart === 'month') return Math.max(0, pickMonth - 1);
                  return Math.max(0, clampDay(pickYear, pickMonth, pickDay) - 1);
                })()}
                getItemLayout={(_, index) => ({ length: 52, offset: 52 * index, index })}
                renderItem={({ item }) => {
                  const active = datePart === 'year'
                    ? item === pickYear
                    : datePart === 'month'
                      ? item === pickMonth
                      : item === clampDay(pickYear, pickMonth, pickDay);
                  return (
                    <TouchableOpacity
                      style={[styles.tzItem, active && styles.tzItemActive]}
                      onPress={() => {
                        if (datePart === 'year') {
                          setPickYear(item);
                          setPickDay(d => clampDay(item, pickMonth, d));
                        } else if (datePart === 'month') {
                          setPickMonth(item);
                          setPickDay(d => clampDay(pickYear, item, d));
                        } else {
                          setPickDay(item);
                        }
                        setDatePart(null);
                      }}
                    >
                      <Text style={[styles.tzLabel, active && styles.tzLabelActive]}>
                        {item}{datePart === 'year' ? '年' : datePart === 'month' ? '月' : '日'}
                      </Text>
                    </TouchableOpacity>
                  );
                }}
              />
            )}
          </View>
        </View>
      </Modal>

      <FireworksOverlay ref={fireworksRef} />
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
    paddingBottom: 40,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textLight,
    marginBottom: 8,
  },
  input: {
    height: 52,
    backgroundColor: COLORS.white,
    borderRadius: 16,
    paddingHorizontal: 20,
    fontSize: 18,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  dpRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  dpField: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  dpLabel: { fontSize: 11, color: COLORS.textLight },
  dpValue: { fontSize: 18, fontWeight: '600', color: COLORS.text, marginTop: 4 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: COLORS.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '60%' },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: COLORS.text },
  modalClose: { fontSize: 16, fontWeight: '600', color: COLORS.kiss },
  tzItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  tzItemActive: { backgroundColor: '#FFF0F3' },
  tzLabel: { fontSize: 16, color: COLORS.text },
  tzLabelActive: { color: COLORS.kiss, fontWeight: '600' },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 8,
  },
  dateRowPinned: { borderColor: COLORS.kiss, backgroundColor: '#FFF5F8' },
  dateTitle: { fontSize: 16, fontWeight: '500', color: COLORS.text },
  dateValue: { fontSize: 13, color: COLORS.textLight, marginTop: 2 },
  pinBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginRight: 10,
  },
  pinBtnActive: { backgroundColor: '#FFF0F3', borderColor: COLORS.kiss },
  pinBtnText: { fontSize: 12, color: COLORS.textLight },
  pinBtnTextActive: { color: COLORS.kiss, fontWeight: '600' },
  dateEdit: { fontSize: 14, color: COLORS.textLight, fontWeight: '500', marginRight: 10 },
  dateDelete: { fontSize: 14, color: '#FF6B6B', fontWeight: '500' },
  addDateForm: { marginTop: 8 },
  recurringToggle: { marginTop: 10, paddingVertical: 6 },
  recurringText: { fontSize: 15, color: COLORS.text },
  addDateActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  addDateCancel: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  addDateCancelText: { fontSize: 15, color: COLORS.textLight },
  addDateConfirm: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.kiss,
  },
  addDateConfirmText: { fontSize: 15, fontWeight: '600', color: COLORS.white },
  calSelected: { fontSize: 13, color: COLORS.kiss, textAlign: 'center', marginTop: 8, fontWeight: '500' },
  addPillContainer: {
    alignItems: 'center',
    marginTop: 8,
  },
  addPill: {
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
  addPillText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
