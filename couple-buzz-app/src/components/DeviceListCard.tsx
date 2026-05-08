import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../constants';
import { api, AuthError, SessionView } from '../services/api';
import { storage } from '../utils/storage';

type Reloadable = { reload: () => Promise<void> };

interface Props {
  onSelfRevoked: () => void;
}

// One physical device → one row. Multiple sessions for the same device
// (created by reinstalls / re-logins) collapse under a single group:
// the visible row reflects the most-recently-active session, but
// rename / promote / revoke fan out to every member of the group so
// the user's mental model "this device" matches what the server does.
interface DeviceGroup {
  key: string;
  representative: SessionView;
  members: SessionView[];
  latest_active: string | null;
  is_primary: boolean;
  is_current: boolean;
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

  const groups = useMemo(() => groupByDevice(sessions ?? []), [sessions]);
  const iAmPrimary = groups.some((g) => g.is_current && g.is_primary);

  const promote = useCallback(async (g: DeviceGroup) => {
    setBusy(g.key);
    try {
      await api.promoteSession(g.representative.session_id);
      await load();
    } catch (e: any) {
      Alert.alert('', e?.message || '操作失败');
    } finally {
      setBusy(null);
    }
  }, [load]);

  const revoke = useCallback(async (g: DeviceGroup) => {
    setBusy(g.key);
    try {
      // Revoke every session backing this device row in parallel. If the
      // group contains the current session, our own session will be one
      // of those revokes — server has already kicked us by the time the
      // promise settles, so we fast-path to SetupScreen instead of
      // waiting for the next API call to bounce.
      const results = await Promise.allSettled(
        g.members.map((m) => api.revokeSession(m.session_id))
      );
      if (g.is_current) {
        await storage.clearAll();
        onSelfRevoked();
        return;
      }
      const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      if (failure) {
        const reason: any = failure.reason;
        Alert.alert('', reason?.message || '部分会话下线失败');
      }
      await load();
    } finally {
      setBusy(null);
    }
  }, [load, onSelfRevoked]);

  const rename = useCallback(async (g: DeviceGroup, raw: string) => {
    const next = raw.trim();
    if (!next) return;
    if (next === (g.representative.device_name ?? '')) return;
    setBusy(g.key);
    try {
      await api.renameSession(g.representative.session_id, next);
      await load();
    } catch (e: any) {
      Alert.alert('', e?.message || '重命名失败');
    } finally {
      setBusy(null);
    }
  }, [load]);

  const promptRename = useCallback((g: DeviceGroup) => {
    // iOS-only Alert.prompt is fine here — the app is iOS / iPadOS only.
    Alert.prompt(
      '重命名设备',
      '在「已登录设备」里显示的名字。',
      [
        { text: '取消', style: 'cancel' },
        { text: '保存', onPress: (v?: string) => rename(g, v ?? '') },
      ],
      'plain-text',
      g.representative.device_name ?? '',
    );
  }, [rename]);

  const onTapRow = useCallback((g: DeviceGroup) => {
    // Action sheet built on Alert so we don't pull in another dep. The
    // composition is intentional: rename always available for self,
    // available for others when the requester is primary; promote only
    // when the requester is primary AND the row isn't already primary;
    // force-logout always available for self, and for others when the
    // requester is primary.
    type Btn = { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void };
    const buttons: Btn[] = [];

    const canRename = g.is_current || iAmPrimary;
    if (canRename) {
      buttons.push({ text: '重命名', onPress: () => promptRename(g) });
    }
    if (!g.is_primary && iAmPrimary) {
      buttons.push({ text: '设为主设备', onPress: () => promote(g) });
    }
    const canRevoke = g.is_current || iAmPrimary;
    if (canRevoke) {
      buttons.push({
        text: g.is_current ? '在此设备退出登录' : '强制下线',
        style: 'destructive',
        onPress: () => confirmRevoke(g),
      });
    }
    buttons.push({ text: '取消', style: 'cancel' });

    if (buttons.length === 1) {
      Alert.alert('', '仅主设备能管理其它设备');
      return;
    }
    Alert.alert(formatDeviceLine(g.representative), formatSubLine(g), buttons);
  }, [iAmPrimary, promote, promptRename]);

  const confirmRevoke = (g: DeviceGroup) => {
    const title = g.is_current ? '在此设备退出登录？' : `强制下线「${formatDeviceLine(g.representative)}」？`;
    const body = g.is_current
      ? '退出后需要重新输入 ID 和密码登录。'
      : '该设备会立刻与你的账号断开，需要重新登录才能再使用。';
    Alert.alert(title, body, [
      { text: '取消', style: 'cancel' },
      { text: '确认', style: 'destructive', onPress: () => revoke(g) },
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
      {groups.map((g, idx) => (
        <TouchableOpacity
          key={g.key}
          activeOpacity={0.7}
          onPress={() => onTapRow(g)}
          style={[styles.row, idx > 0 && styles.rowDivider]}
        >
          <Text style={styles.rowEmoji}>{deviceEmoji(g.representative)}</Text>
          <View style={styles.rowMain}>
            <View style={styles.rowTitleLine}>
              <Text style={styles.rowTitle} numberOfLines={1}>{formatDeviceLine(g.representative)}</Text>
              {g.is_primary ? <Text style={styles.primaryBadge}>主设备</Text> : null}
              {g.is_current ? <Text style={styles.currentBadge}>本机</Text> : null}
            </View>
            <Text style={styles.rowSub} numberOfLines={1}>{formatSubLine(g)}</Text>
          </View>
          {busy === g.key ? <ActivityIndicator color={COLORS.kiss} /> : <Text style={styles.chevron}>›</Text>}
        </TouchableOpacity>
      ))}
      {!iAmPrimary && groups.length > 1 ? (
        <Text style={styles.footnote}>仅主设备能强制下线其它设备</Text>
      ) : null}
    </View>
  );
});

export default DeviceListCard;

// Group by (device_name, device_os). Null fields fold into a shared
// bucket so legacy rows from before the device-info feature don't
// fragment into a row each.
function groupByDevice(sessions: SessionView[]): DeviceGroup[] {
  const buckets = new Map<string, SessionView[]>();
  for (const s of sessions) {
    const key = `${s.device_name ?? ''}|${s.device_os ?? ''}`;
    const list = buckets.get(key);
    if (list) list.push(s);
    else buckets.set(key, [s]);
  }
  const groups: DeviceGroup[] = [];
  for (const [key, members] of buckets) {
    // Representative = most-recently-active row; that's the one the
    // user mentally identifies as "this device right now". Falling
    // back to created_at handles the brand-new-session case where
    // last_active hasn't been touched yet.
    const sorted = [...members].sort(
      (a, b) => activityTime(b) - activityTime(a)
    );
    const rep = sorted[0];
    const latest = rep.last_active ?? rep.created_at;
    groups.push({
      key,
      representative: rep,
      members,
      latest_active: latest,
      is_primary: members.some((m) => m.is_primary),
      is_current: members.some((m) => m.is_current),
    });
  }
  return groups.sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    return activityTimeOf(b.latest_active) - activityTimeOf(a.latest_active);
  });
}

function activityTime(s: SessionView): number {
  return activityTimeOf(s.last_active ?? s.created_at);
}

function activityTimeOf(iso: string | null): number {
  if (!iso) return 0;
  const isoZ = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const t = new Date(isoZ).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function deviceEmoji(s: SessionView): string {
  const o = (s.device_os ?? '').toLowerCase();
  if (o.includes('macos')) return '💻';
  if (o.includes('ipados')) return '📱';
  return '📱';
}

function formatDeviceLine(s: SessionView): string {
  const name = s.device_name?.trim();
  if (name) return name;
  if (s.device_os) return s.device_os;
  return '未知设备';
}

function formatSubLine(g: DeviceGroup): string {
  const parts: string[] = [];
  const os = g.representative.device_os;
  if (os) parts.push(os);
  parts.push(`活跃于 ${formatRelativeTime(g.latest_active)}`);
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
