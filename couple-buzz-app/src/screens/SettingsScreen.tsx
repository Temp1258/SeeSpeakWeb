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
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../constants';
import { api } from '../services/api';
import { storage } from '../utils/storage';
import WeeklyReportCard from '../components/WeeklyReportCard';
import StatsCard from '../components/StatsCard';
import DeviceListCard from '../components/DeviceListCard';
import { SpringPressable } from '../components/SpringPressable';

type Reloadable = { reload: () => Promise<void> };

const TIMEZONES = [
  { value: 'Asia/Shanghai', label: '北京时间', offset: 'UTC+8' },
  { value: 'Asia/Hong_Kong', label: '香港', offset: 'UTC+8' },
  { value: 'Asia/Taipei', label: '台北', offset: 'UTC+8' },
  { value: 'Asia/Tokyo', label: '东京', offset: 'UTC+9' },
  { value: 'Asia/Seoul', label: '首尔', offset: 'UTC+9' },
  { value: 'Asia/Singapore', label: '新加坡', offset: 'UTC+8' },
  { value: 'America/New_York', label: '纽约', offset: 'UTC-5' },
  { value: 'America/Los_Angeles', label: '洛杉矶', offset: 'UTC-8' },
  { value: 'America/Chicago', label: '芝加哥', offset: 'UTC-6' },
  { value: 'Europe/London', label: '伦敦', offset: 'UTC+0' },
  { value: 'Europe/Paris', label: '巴黎', offset: 'UTC+1' },
  { value: 'Europe/Berlin', label: '柏林', offset: 'UTC+1' },
  { value: 'Australia/Sydney', label: '悉尼', offset: 'UTC+11' },
  { value: 'Pacific/Auckland', label: '奥克兰', offset: 'UTC+13' },
];

type ModalTarget = 'my' | 'partner' | null;

interface Props {
  // App.tsx hands this in so a self-revoke from DeviceListCard can pop
  // back to SetupScreen without each component re-implementing the
  // clearAll → state-swap flow.
  onSelfRevoked: () => void;
}

export default function SettingsScreen({ onSelfRevoked }: Props) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [partnerTimezone, setPartnerTimezone] = useState('');
  const [partnerRemark, setPartnerRemark] = useState('');
  const [originalName, setOriginalName] = useState('');
  const [originalTimezone, setOriginalTimezone] = useState('');
  const [originalPartnerTz, setOriginalPartnerTz] = useState('');
  const [originalPartnerRemark, setOriginalPartnerRemark] = useState('');
  const [saving, setSaving] = useState(false);
  const [modalTarget, setModalTarget] = useState<ModalTarget>(null);
  // Tap on a tz row only updates this draft; the change is committed (and
  // sent to the server) when the user explicitly taps "完成". Lets the
  // user browse options without each tap firing a save round-trip.
  const [pendingTimezone, setPendingTimezone] = useState<string>('');
  const [userId, setUserId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [pairId, setPairId] = useState<string | null>(null);
  const [unpairing, setUnpairing] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const status = await api.getStatus();
      setName(status.name);
      setTimezone(status.timezone);
      setPartnerTimezone(status.partner_timezone);
      setPartnerRemark(status.partner_remark || '');
      setOriginalName(status.name);
      setOriginalTimezone(status.timezone);
      setOriginalPartnerTz(status.partner_timezone);
      setOriginalPartnerRemark(status.partner_remark || '');
      await storage.setPartnerRemark(status.partner_remark || '');
      if (status.partner_id) {
        setPartnerId(status.partner_id);
        await storage.setPartnerId(status.partner_id);
      } else {
        setPartnerId('');
      }
      setPairId(status.pair_id ?? null);
    } catch {
      const localName = await storage.getUserName();
      if (localName) setName(localName);
      const cachedRemark = await storage.getPartnerRemark();
      if (cachedRemark) {
        setPartnerRemark(cachedRemark);
        setOriginalPartnerRemark(cachedRemark);
      }
      const cachedPid = await storage.getPartnerId();
      if (cachedPid) setPartnerId(cachedPid);
    }
    const id = await storage.getUserId();
    if (id) setUserId(id);
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const weeklyRef = useRef<Reloadable>(null);
  const statsRef = useRef<Reloadable>(null);
  const devicesRef = useRef<Reloadable>(null);
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
        loadStatus(),
        weeklyRef.current?.reload(),
        statsRef.current?.reload(),
        devicesRef.current?.reload(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [loadStatus]);

  useFocusEffect(
    useCallback(() => {
      loadStatus();
    }, [loadStatus])
  );

  const trimmedName = name.trim();
  const trimmedRemark = partnerRemark.trim();
  const hasNameChange = trimmedName !== originalName;
  const hasRemarkChange = trimmedRemark !== originalPartnerRemark.trim();
  // Save enabled iff the user actually changed something AND the nickname
  // isn't blank (server rejects empty name; we mirror that as an inline
  // disabled state so the user gets immediate signal rather than an alert).
  const canSave = (hasNameChange || hasRemarkChange) && trimmedName.length > 0;

  const persistProfile = async (next: { name?: string; timezone?: string; partnerTimezone?: string; partnerRemark?: string }): Promise<void> => {
    const result = await api.updateProfile(
      next.name ?? (name.trim() || originalName),
      next.timezone ?? timezone,
      next.partnerTimezone ?? partnerTimezone,
      next.partnerRemark ?? partnerRemark,
    );
    await Promise.all([
      storage.setUserName(result.name),
      storage.setTimezone(result.timezone),
      storage.setPartnerTimezone(result.partner_timezone),
      storage.setPartnerRemark(result.partner_remark),
    ]);
    setName(result.name);
    setTimezone(result.timezone);
    setPartnerTimezone(result.partner_timezone);
    setPartnerRemark(result.partner_remark);
    setOriginalName(result.name);
    setOriginalTimezone(result.timezone);
    setOriginalPartnerTz(result.partner_timezone);
    setOriginalPartnerRemark(result.partner_remark);
  };

  // Single save — pushes both nickname and partner-remark in one API call.
  // persistProfile already accepts both; passing them together avoids two
  // round-trips and keeps the UI gesture (one tap) atomic.
  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await persistProfile({ name: trimmedName, partnerRemark: trimmedRemark });
      Alert.alert('', '已保存');
    } catch (error: any) {
      Alert.alert('保存失败', error.message);
    } finally {
      setSaving(false);
    }
  };

  const openTimezoneModal = (target: 'my' | 'partner') => {
    // Seed the draft with the currently-saved value so the user sees their
    // current selection highlighted on open.
    setPendingTimezone(target === 'my' ? timezone : partnerTimezone);
    setModalTarget(target);
  };

  // 4-step diff'd confirmation gauntlet so a casual mis-tap can never
  // tear down a relationship's data. Each step asks something different
  // (not the same dialog spammed) — we want the user to actually read.
  const startUnpairFlow = () => {
    if (unpairing) return;
    if (!partnerId) {
      Alert.alert('', '当前没有绑定的对象');
      return;
    }
    const partnerLabel = partnerRemark.trim() || 'ta';
    const step4 = () => {
      Alert.alert(
        '最后一次确认',
        `点确定后立即解除与 ${partnerLabel} 的绑定。\n\n之后双方共享的数据会进入 90 天保留期 —— 在此期间你们任意一方重新绑定，所有历史会原样恢复；过了 90 天就永久删除，无法恢复。`,
        [
          { text: '我再想想', style: 'cancel' },
          { text: '确定解绑', style: 'destructive', onPress: doUnpair },
        ],
      );
    };
    const step3 = () => {
      Alert.alert(
        '想清楚了吗？',
        `解绑会断开你们当前所有连接 —— 实时拍拍、便利贴、信件统统不再互通。\n\n如果只是想暂时安静一下，关 push 就行了，不用走这一步。`,
        [
          { text: '取消', style: 'cancel' },
          { text: '继续', style: 'destructive', onPress: step4 },
        ],
      );
    };
    const step2 = () => {
      Alert.alert(
        '不再考虑一下吗？',
        `${partnerLabel} 不会收到提示后被询问 —— 你点完确定，对方那边就直接被解绑了。`,
        [
          { text: '再想想', style: 'cancel' },
          { text: '已经决定了', style: 'destructive', onPress: step3 },
        ],
      );
    };
    Alert.alert(
      '你真的要和 ta 解除绑定吗？',
      `这是不可逆操作的开始。${partnerLabel} 那边会立即看到"已解绑"。`,
      [
        { text: '不了', style: 'cancel' },
        { text: '是的', style: 'destructive', onPress: step2 },
      ],
    );
  };

  const doUnpair = async () => {
    setUnpairing(true);
    try {
      await api.unpair();
      // Wipe local cached partner-bound state so the UI immediately
      // reflects the unpaired state without a stale flash.
      await Promise.all([
        storage.setPartnerId(''),
        storage.setPartnerName(''),
        storage.setPartnerRemark(''),
      ]);
      setPartnerId('');
      setPartnerRemark('');
      setOriginalPartnerRemark('');
      Alert.alert('已解绑', '你们的数据将保留 90 天。期间任意一方重新和 ta 绑定就会自动恢复。');
      // Trigger a status reload so other screens (Mailbox / Daily / etc)
      // see the unpaired state on next focus.
      loadStatus();
    } catch (e: any) {
      Alert.alert('解绑失败', e?.message || '请稍后重试');
    } finally {
      setUnpairing(false);
    }
  };

  const handleConfirmTimezone = async () => {
    const target = modalTarget;
    const tz = pendingTimezone;
    setModalTarget(null);
    if (!target || !tz) return;
    const current = target === 'my' ? timezone : partnerTimezone;
    if (tz === current) return; // no-op confirm
    try {
      if (target === 'my') {
        await persistProfile({ timezone: tz });
      } else {
        await persistProfile({ partnerTimezone: tz });
      }
      Alert.alert('', '已保存');
    } catch (error: any) {
      Alert.alert('保存失败', error.message);
    }
  };

  const formatTzDisplay = (tz: string) => {
    const found = TIMEZONES.find(t => t.value === tz);
    return found ? `${found.label} (${found.offset})` : tz;
  };

  // Highlight the in-modal selection (the draft), not the saved value, so
  // the row the user just tapped immediately reflects their pick.
  const activeValue = pendingTimezone;

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
    <Animated.ScrollView
      contentContainerStyle={styles.content}
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
      {userId ? (
        <View style={styles.coupleIdRow}>
          <View style={styles.idCard}>
            <Text style={styles.idLabel}>我的 ID</Text>
            <Text style={styles.idValue}>{userId}</Text>
          </View>
          <View style={styles.idLink}>
            <Text style={styles.idLinkHeart}>💞</Text>
            <Text style={styles.idLinkArrow}>⇄</Text>
          </View>
          <View style={styles.idCard}>
            <Text style={styles.idLabel}>ta 的 ID</Text>
            <Text style={[styles.idValue, !partnerId && styles.idValueEmpty]}>
              {partnerId || '— —'}
            </Text>
          </View>
        </View>
      ) : null}

      {/* 关系编号 — pair_id is the stable handle for this relationship.
          Persists across unpair/repair within the 90-day grace window;
          re-pairing the same partner brings the same number back. */}
      {pairId ? (
        <View style={styles.pairIdCard}>
          <Text style={styles.pairIdLabel}>你们的关系编号</Text>
          <Text style={styles.pairIdValue}>{pairId}</Text>
          <Text style={styles.pairIdHint}>解绑后 90 天内重新和 ta 绑定，所有数据按此编号原样恢复</Text>
        </View>
      ) : null}

      <WeeklyReportCard ref={weeklyRef} />
      <StatsCard ref={statsRef} />

      {/* Paired row mirroring the ID / timezone pattern. Internal labels
          ("昵称" / "ta 的备注") replace the standalone section titles, and
          a single 灵动岛 "保存" pill below saves both fields atomically. */}
      <View style={styles.namePairRow}>
        <View style={styles.nameCard}>
          <Text style={styles.nameCardLabel}>昵称</Text>
          <TextInput
            style={styles.nameCardInput}
            value={name}
            onChangeText={setName}
            maxLength={20}
            placeholder="输入昵称"
            placeholderTextColor={COLORS.textLight}
            textAlign="center"
          />
        </View>
        {partnerId ? (
          <>
            <View style={styles.namePairLink}>
              <Text style={styles.namePairLinkIcon}>💕</Text>
            </View>
            <View style={styles.nameCard}>
              <Text style={styles.nameCardLabel}>ta 的备注</Text>
              <TextInput
                style={styles.nameCardInput}
                value={partnerRemark}
                onChangeText={setPartnerRemark}
                maxLength={20}
                placeholder="给 ta 起个昵称"
                placeholderTextColor={COLORS.textLight}
                textAlign="center"
              />
            </View>
          </>
        ) : null}
      </View>
      <View style={styles.savePillContainer}>
        <SpringPressable
          onPress={handleSave}
          disabled={!canSave || saving}
          scaleTo={1.08}
          style={[styles.savePill, (!canSave || saving) && styles.savePillDisabled]}
        >
          <Text style={styles.savePillText}>{saving ? '保存中...' : '保存'}</Text>
        </SpringPressable>
      </View>

      <Text style={[styles.sectionTitle, { marginTop: 40 }]}>时区</Text>
      <View style={styles.tzPairRow}>
        <TouchableOpacity style={styles.tzCard} onPress={() => openTimezoneModal('my')}>
          <Text style={styles.tzCardLabel}>我的时区</Text>
          <Text style={styles.tzCardValue} numberOfLines={1}>{formatTzDisplay(timezone)}</Text>
        </TouchableOpacity>
        <View style={styles.tzPairLink}>
          <Text style={styles.tzPairLinkIcon}>🕐</Text>
        </View>
        <TouchableOpacity style={styles.tzCard} onPress={() => openTimezoneModal('partner')}>
          <Text style={styles.tzCardLabel}>ta 的时区</Text>
          <Text style={styles.tzCardValue} numberOfLines={1}>{formatTzDisplay(partnerTimezone)}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.devicesBlock}>
        <DeviceListCard ref={devicesRef} onSelfRevoked={onSelfRevoked} />
      </View>

      {partnerId ? (
        <View style={styles.unpairBlock}>
          <SpringPressable
            onPress={startUnpairFlow}
            disabled={unpairing}
            scaleTo={1.04}
            style={[styles.unpairPill, unpairing && styles.unpairPillDisabled]}
          >
            <Text style={styles.unpairPillText}>{unpairing ? '解绑中...' : '解除绑定'}</Text>
          </SpringPressable>
          <Text style={styles.unpairCaption}>
            解绑后双方数据保留 90 天，期间重新绑定可恢复
          </Text>
        </View>
      ) : null}

      <Modal
        visible={modalTarget !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setModalTarget(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {modalTarget === 'my' ? '我的时区' : '对方时区'}
              </Text>
              <TouchableOpacity onPress={handleConfirmTimezone}>
                <Text style={styles.modalClose}>完成</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={TIMEZONES}
              keyExtractor={(item) => item.value}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.tzItem, item.value === activeValue && styles.tzItemActive]}
                  onPress={() => setPendingTimezone(item.value)}
                >
                  <Text style={[styles.tzLabel, item.value === activeValue && styles.tzLabelActive]}>
                    {item.label}
                  </Text>
                  <Text style={styles.tzOffset}>{item.offset}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>

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
  coupleIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 8,
  },
  idCard: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  idLabel: {
    fontSize: 12,
    color: COLORS.textLight,
  },
  idValue: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.kiss,
    letterSpacing: 2,
    marginTop: 4,
  },
  idValueEmpty: {
    color: COLORS.textLight,
    letterSpacing: 4,
  },
  idLink: {
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  idLinkHeart: {
    fontSize: 22,
  },
  idLinkArrow: {
    fontSize: 16,
    color: COLORS.kiss,
    fontWeight: '700',
    marginTop: -2,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textLight,
    marginBottom: 8,
    marginTop: 20,
  },
  namePairRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    gap: 8,
  },
  nameCard: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  nameCardLabel: {
    fontSize: 12,
    color: COLORS.textLight,
  },
  nameCardInput: {
    width: '100%',
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
    marginTop: 4,
    // Let platform-default vertical metrics take over so the text sits at
    // the natural baseline; center-aligned via textAlign on the JSX side.
    paddingVertical: 2,
    paddingHorizontal: 0,
  },
  namePairLink: {
    paddingHorizontal: 4,
  },
  namePairLinkIcon: {
    fontSize: 18,
  },
  savePillContainer: {
    alignItems: 'center',
    marginTop: 18,
  },
  savePill: {
    paddingHorizontal: 36,
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
  savePillDisabled: {
    opacity: 0.4,
  },
  savePillText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  tzPairRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tzCard: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  tzCardLabel: {
    fontSize: 12,
    color: COLORS.textLight,
  },
  tzCardValue: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
    marginTop: 6,
  },
  tzPairLink: {
    paddingHorizontal: 4,
  },
  tzPairLinkIcon: {
    fontSize: 18,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '60%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.text,
  },
  modalClose: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.kiss,
  },
  tzItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  tzItemActive: {
    backgroundColor: '#FFF0F3',
  },
  tzLabel: {
    fontSize: 16,
    color: COLORS.text,
  },
  tzLabelActive: {
    color: COLORS.kiss,
    fontWeight: '600',
  },
  tzOffset: {
    fontSize: 14,
    color: COLORS.textLight,
  },
  devicesBlock: {
    marginTop: 32,
  },
  unpairBlock: {
    alignItems: 'center',
    marginTop: 48,
    marginBottom: 8,
    gap: 8,
  },
  unpairPill: {
    paddingHorizontal: 28,
    paddingVertical: 11,
    borderRadius: 22,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(220, 60, 60, 0.45)',
    minWidth: 140,
    alignItems: 'center',
  },
  unpairPillDisabled: {
    opacity: 0.4,
  },
  unpairPillText: {
    color: '#C84040',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  unpairCaption: {
    fontSize: 11,
    color: COLORS.textLight,
    textAlign: 'center',
  },
  pairIdCard: {
    marginTop: 14,
    backgroundColor: COLORS.white,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  pairIdLabel: {
    fontSize: 12,
    color: COLORS.textLight,
  },
  pairIdValue: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.kiss,
    letterSpacing: 3,
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  pairIdHint: {
    fontSize: 11,
    color: COLORS.textLight,
    marginTop: 6,
    textAlign: 'center',
  },
});
