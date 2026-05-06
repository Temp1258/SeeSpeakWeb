import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../constants';
import { api, AuthError, SessionView } from '../services/api';
import { storage } from '../utils/storage';

type Reloadable = { reload: () => Promise<void> };

interface Props {
  onSelfRevoked: () => void;
}

const DeviceListCard = forwardRef<Reloadable, Props>(({ onSelfRevoked }, ref) => {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.listSessions();
      setSessions(result.sessions);
    } catch (e) {
      if (e instanceof AuthError) onSelfRevoked();
      // Network errors leave previously-loaded list in place; the user
      // pulls-to-refresh upstream when the connection comes back.
    }
  }, [onSelfRevoked]);

  useImperativeHandle(ref, () => ({ reload: load }), [load]);
  useEffect(() => { load(); }, [load]);

  const me = sessions?.find((s) => s.is_current);
  const iAmPrimary = !!me?.is_primary;

  const promote = useCallback(async (s: SessionView) => {
    setBusy(s.session_id);
    try {
      await api.promoteSession(s.session_id);
      await load();
    } catch (e: any) {
      Alert.alert('', e?.message || '操作失败');
    } finally {
      setBusy(null);
    }
  }, [load]);

  const revoke = useCallback(async (s: SessionView) => {
    setBusy(s.session_id);
    try {
      await api.revokeSession(s.session_id);
      if (s.is_current) {
        // Server has already revoked our session; the next API call would
        // 401. Fast-path the logout: clear local storage and notify the
        // host to swap to SetupScreen instead of waiting for the bounce.
        await storage.clearAll();
        onSelfRevoked();
        return;
      }
      await load();
    } catch (e: any) {
      Alert.alert('', e?.message || '操作失败');
    } finally {
      setBusy(null);
    }
  }, [load, onSelfRevoked]);

  const onTapRow = useCallback((s: SessionView) => {
    // Action sheet built on Alert so we don't pull in another dep. The
    // composition is intentional: "set as primary" only makes sense for
    // a non-primary session and only when the requester IS primary;
    // "force-logout" is always available for self, and for others when
    // the requester is primary. A non-primary requester tapping another
    // device just sees "在此设备退出登录" if it's their own row.
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];
    const canTransfer = !s.is_primary && (iAmPrimary || s.is_current);
    if (canTransfer && (iAmPrimary || s.is_current === false)) {
      // "set as primary" requires either: (a) requester is primary, or
      // (b) the row is the requester themselves AND they're not primary
      //     yet — but that's the exact case where server requires an
      //     existing primary; we just keep this client-side check loose
      //     and let the server do the final auth.
      if (iAmPrimary) {
        buttons.push({ text: '设为主设备', onPress: () => promote(s) });
      }
    }
    const canRevoke = s.is_current || iAmPrimary;
    if (canRevoke) {
      buttons.push({
        text: s.is_current ? '在此设备退出登录' : '强制下线',
        style: 'destructive',
        onPress: () => confirmRevoke(s),
      });
    }
    buttons.push({ text: '取消', style: 'cancel' });

    if (buttons.length === 1) {
      // Only "Cancel" — nothing to offer for this row given current
      // permissions. Show a hint instead of a useless single-option sheet.
      Alert.alert('', '仅主设备能管理其它设备');
      return;
    }
    Alert.alert(formatDeviceLine(s), formatSubLine(s), buttons);
  }, [iAmPrimary, promote]);

  const confirmRevoke = (s: SessionView) => {
    const title = s.is_current ? '在此设备退出登录？' : `强制下线「${formatDeviceLine(s)}」？`;
    const body = s.is_current
      ? '退出后需要重新输入 ID 和密码登录。'
      : '该设备会立刻与你的账号断开，需要重新登录才能再使用。';
    Alert.alert(title, body, [
      { text: '取消', style: 'cancel' },
      { text: '确认', style: 'destructive', onPress: () => revoke(s) },
    ]);
  };

  if (sessions === null) {
    return (
      <View style={styles.card}>
        <Text style={styles.header}>已登录设备</Text>
        <View style={styles.loadingRow}>
          <ActivityIndicator color={COLORS.kiss} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.header}>已登录设备</Text>
      {sessions.map((s, idx) => (
        <TouchableOpacity
          key={s.session_id}
          activeOpacity={0.7}
          onPress={() => onTapRow(s)}
          style={[styles.row, idx > 0 && styles.rowDivider]}
        >
          <Text style={styles.rowEmoji}>{deviceEmoji(s)}</Text>
          <View style={styles.rowMain}>
            <View style={styles.rowTitleLine}>
              <Text style={styles.rowTitle} numberOfLines={1}>{formatDeviceLine(s)}</Text>
              {s.is_primary ? <Text style={styles.primaryBadge}>主设备</Text> : null}
              {s.is_current ? <Text style={styles.currentBadge}>本机</Text> : null}
            </View>
            <Text style={styles.rowSub} numberOfLines={1}>{formatSubLine(s)}</Text>
          </View>
          {busy === s.session_id ? <ActivityIndicator color={COLORS.kiss} /> : <Text style={styles.chevron}>›</Text>}
        </TouchableOpacity>
      ))}
      {!iAmPrimary && sessions.length > 1 ? (
        <Text style={styles.footnote}>仅主设备能强制下线其它设备</Text>
      ) : null}
    </View>
  );
});

export default DeviceListCard;

function deviceEmoji(s: SessionView): string {
  const m = (s.device_model ?? '').toLowerCase();
  const n = (s.device_name ?? '').toLowerCase();
  const o = (s.device_os ?? '').toLowerCase();
  if (m.includes('ipad') || n.includes('ipad') || o.includes('ipados')) return '📱';
  if (o.includes('android')) return '📱';
  return '📱';
}

function formatDeviceLine(s: SessionView): string {
  const name = s.device_name?.trim();
  if (name) return name;
  if (s.device_os) return s.device_os;
  return '未知设备';
}

function formatSubLine(s: SessionView): string {
  const parts: string[] = [];
  if (s.device_os) parts.push(s.device_os);
  const last = s.last_active ?? s.created_at;
  parts.push(`活跃于 ${formatRelativeTime(last)}`);
  return parts.join(' · ');
}

// "10 分钟前 / 3 小时前 / 昨天 / 5 天前 / 2026-04-21" style relative
// time. Avoids pulling in a date lib.
function formatRelativeTime(iso: string | null): string {
  if (!iso) return '不久前';
  // SQLite default format ("YYYY-MM-DD HH:MM:SS") parses inconsistently
  // across engines unless we patch it to ISO-Z first.
  const isoZ = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const t = new Date(isoZ).getTime();
  if (Number.isNaN(t)) return '不久前';
  const diffMs = Date.now() - t;
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return '昨天';
  if (d < 7) return `${d} 天前`;
  const date = new Date(t);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  header: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textLight,
    marginBottom: 8,
  },
  loadingRow: { paddingVertical: 16, alignItems: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  rowEmoji: { fontSize: 22 },
  rowMain: { flex: 1, gap: 2 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: COLORS.text, flexShrink: 1 },
  primaryBadge: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.white,
    backgroundColor: COLORS.kiss,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    overflow: 'hidden',
  },
  currentBadge: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.kiss,
    borderColor: COLORS.kiss,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  rowSub: { fontSize: 12, color: COLORS.textLight },
  chevron: { fontSize: 22, color: COLORS.textLight, fontWeight: '300' },
  footnote: {
    fontSize: 11,
    color: COLORS.textLight,
    marginTop: 8,
    textAlign: 'center',
  },
});
