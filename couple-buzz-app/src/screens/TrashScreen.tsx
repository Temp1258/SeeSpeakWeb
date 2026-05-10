import React, { useEffect, useState, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import {
  Modal,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants';
import { api, TrashedInboxItem } from '../services/api';
import { storage } from '../utils/storage';
import IslandToast, { IslandToastHandle } from '../components/IslandToast';

interface Props {
  visible: boolean;
  onClose: () => void;
  // Notified after restore so the parent (信箱) can refresh its inbox view.
  onAfterRestore?: () => void;
}

export interface TrashHandle {
  reload: () => Promise<void>;
}

interface DisplayItem extends TrashedInboxItem {
  fromName: string;
  toName: string;
  kindLabel: string;
  accent: string;
}

const MAILBOX_ACCENT = '#FFB5C2';
const CAPSULE_ACCENT = '#C3AED6';

const TrashScreen = forwardRef<TrashHandle, Props>(({ visible, onClose, onAfterRestore }, ref) => {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toastRef = useRef<IslandToastHandle>(null);

  const load = useCallback(async () => {
    try {
      const [myName, partnerRemark, partnerName, trash] = await Promise.all([
        storage.getUserName(),
        storage.getPartnerRemark(),
        storage.getPartnerName(),
        api.getInboxTrash().catch(() => ({ items: [] as TrashedInboxItem[] })),
      ]);
      const me = myName || '我';
      const ta = (partnerRemark && partnerRemark.trim()) || partnerName || 'ta';

      const display: DisplayItem[] = (trash.items || []).map(it => {
        if (it.kind === 'mailbox') {
          return {
            ...it,
            fromName: ta,
            toName: me,
            kindLabel: '半日达 · 来自 ta',
            accent: MAILBOX_ACCENT,
          };
        }
        // capsule
        let fromName = me;
        let toName = ta;
        let kindLabel = '择日达';
        if (it.author === 'me' && it.visibility === 'self') {
          fromName = me; toName = me;
          kindLabel = '择日达 · 给自己';
        } else if (it.author === 'partner') {
          fromName = ta; toName = me;
          kindLabel = '择日达 · 来自 ta';
        }
        return {
          ...it,
          fromName,
          toName,
          kindLabel,
          accent: CAPSULE_ACCENT,
        };
      });
      setItems(display);
    } finally {
      setLoading(false);
    }
  }, []);

  useImperativeHandle(ref, () => ({ reload: load }), [load]);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setSelectionMode(false);
    setSelected(new Set());
    load();
  }, [visible, load]);

  const itemKey = (it: DisplayItem) => `${it.kind}-${it.ref_id}`;

  const toggleSelection = (it: DisplayItem) => {
    const k = itemKey(it);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const restoreOne = async (it: DisplayItem) => {
    setItems(prev => prev.filter(x => itemKey(x) !== itemKey(it)));
    toastRef.current?.show('已恢复到收件箱');
    try {
      await api.restoreInboxItem(it.kind, it.ref_id);
      onAfterRestore?.();
    } catch {
      toastRef.current?.show('恢复失败');
      load();
    }
  };

  const purgeOne = (it: DisplayItem) => {
    Alert.alert('彻底删除？', '彻底删除后无法恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '彻底删除',
        style: 'destructive',
        onPress: async () => {
          setItems(prev => prev.filter(x => itemKey(x) !== itemKey(it)));
          toastRef.current?.show('已彻底删除');
          try {
            await api.purgeInboxItem(it.kind, it.ref_id);
          } catch {
            toastRef.current?.show('删除失败');
            load();
          }
        },
      },
    ]);
  };

  const restoreSelected = async () => {
    const targets = items.filter(it => selected.has(itemKey(it)));
    if (targets.length === 0) {
      toastRef.current?.show('没有选中的信件');
      return;
    }
    setItems(prev => prev.filter(x => !selected.has(itemKey(x))));
    toastRef.current?.show(`已恢复 ${targets.length} 封`);
    setSelected(new Set());
    setSelectionMode(false);
    try {
      await Promise.all(targets.map(it => api.restoreInboxItem(it.kind, it.ref_id)));
      onAfterRestore?.();
    } catch {
      toastRef.current?.show('部分恢复失败');
      load();
    }
  };

  const purgeSelected = () => {
    const targets = items.filter(it => selected.has(itemKey(it)));
    if (targets.length === 0) {
      toastRef.current?.show('没有选中的信件');
      return;
    }
    Alert.alert(`彻底删除 ${targets.length} 封？`, '彻底删除后无法恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '彻底删除',
        style: 'destructive',
        onPress: async () => {
          setItems(prev => prev.filter(x => !selected.has(itemKey(x))));
          toastRef.current?.show(`已彻底删除 ${targets.length} 封`);
          setSelected(new Set());
          setSelectionMode(false);
          try {
            await Promise.all(targets.map(it => api.purgeInboxItem(it.kind, it.ref_id)));
          } catch {
            toastRef.current?.show('部分删除失败');
            load();
          }
        },
      },
    ]);
  };

  const allSelected = items.length > 0 && selected.size === items.length;
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(items.map(itemKey)));
  };

  const toggleSelectionMode = () => {
    setSelectionMode(prev => {
      if (prev) setSelected(new Set());
      return !prev;
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
    >
      <Pressable
        style={[styles.container, { paddingTop: insets.top + 8 }]}
        onPress={onClose}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}>
            <Text style={styles.closeBtn}>完成</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>🗑️ 废件箱</Text>
          {items.length > 0 ? (
            <TouchableOpacity onPress={toggleSelectionMode} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}>
              <Text style={styles.actionBtn}>{selectionMode ? '取消' : '选择'}</Text>
            </TouchableOpacity>
          ) : (
            <View style={{ width: 40 }} />
          )}
        </View>

        {selectionMode ? (
          <View style={styles.selectionBar}>
            <TouchableOpacity onPress={toggleSelectAll}>
              <Text style={styles.selectionLink}>{allSelected ? '全不选' : '全选'}</Text>
            </TouchableOpacity>
            <Text style={styles.selectionCount}>已选 {selected.size} / {items.length}</Text>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={COLORS.kiss} />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyEmoji}>🗑️</Text>
            <Text style={styles.emptyTitle}>废件箱是空的</Text>
            <Text style={styles.emptySub}>右划收件箱里的信会进到这里</Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + (selectionMode ? 100 : 24) }]}
            showsVerticalScrollIndicator={false}
          >
            {items.map(it => {
              const k = itemKey(it);
              const isSelected = selected.has(k);
              return (
                <TouchableOpacity
                  key={k}
                  activeOpacity={selectionMode ? 0.7 : 1}
                  onPress={() => selectionMode && toggleSelection(it)}
                  style={[
                    styles.row,
                    { borderLeftColor: it.accent },
                    selectionMode && isSelected ? styles.rowSelected : null,
                  ]}
                >
                  {selectionMode ? (
                    <Text style={styles.checkbox}>{isSelected ? '☑️' : '⬜'}</Text>
                  ) : null}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowKind}>{it.kindLabel}</Text>
                    <Text style={styles.rowFromTo}>
                      {it.fromName} → {it.toName} · {it.date}
                    </Text>
                    <Text style={styles.rowSnippet} numberOfLines={2}>
                      {it.content}
                    </Text>
                  </View>
                  {!selectionMode ? (
                    <View style={styles.rowActions}>
                      <TouchableOpacity
                        onPress={() => restoreOne(it)}
                        style={[styles.iconBtn, styles.restoreBtn]}
                      >
                        <Text style={styles.restoreText}>恢复</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => purgeOne(it)}
                        style={[styles.iconBtn, styles.deleteBtn]}
                      >
                        <Text style={styles.deleteText}>删除</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {selectionMode && items.length > 0 ? (
          <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 8 }]}>
            <TouchableOpacity
              style={[styles.bigBtn, styles.restoreBig, selected.size === 0 && styles.btnDisabled]}
              onPress={restoreSelected}
              disabled={selected.size === 0}
            >
              <Text style={styles.bigBtnText}>全部恢复 ({selected.size})</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.bigBtn, styles.deleteBig, selected.size === 0 && styles.btnDisabled]}
              onPress={purgeSelected}
              disabled={selected.size === 0}
            >
              <Text style={[styles.bigBtnText, styles.deleteBigText]}>全部删除 ({selected.size})</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <IslandToast ref={toastRef} top={insets.top + 8} />
      </Pressable>
    </Modal>
  );
});

export default TrashScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
  },
  closeBtn: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.kiss,
    minWidth: 40,
  },
  actionBtn: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.kiss,
    minWidth: 40,
    textAlign: 'right',
  },
  selectionBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  selectionLink: {
    fontSize: 14,
    color: COLORS.kiss,
    fontWeight: '600',
  },
  selectionCount: {
    fontSize: 13,
    color: COLORS.textLight,
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
  list: {
    paddingHorizontal: 16,
    paddingTop: 4,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderLeftWidth: 4,
    gap: 10,
  },
  rowSelected: {
    backgroundColor: '#FFF0F3',
    borderColor: COLORS.kiss,
    borderLeftColor: COLORS.kiss,
  },
  checkbox: {
    fontSize: 18,
  },
  rowKind: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.kiss,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  rowFromTo: {
    fontSize: 13,
    color: COLORS.text,
    fontWeight: '600',
    marginTop: 2,
  },
  rowSnippet: {
    fontSize: 13,
    color: COLORS.textLight,
    lineHeight: 18,
    marginTop: 4,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 6,
  },
  iconBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  restoreBtn: {
    borderColor: COLORS.kiss,
    backgroundColor: '#FFF0F3',
  },
  restoreText: {
    fontSize: 12,
    color: COLORS.kiss,
    fontWeight: '600',
  },
  deleteBtn: {
    borderColor: '#E07070',
    backgroundColor: '#FFEEEE',
  },
  deleteText: {
    fontSize: 12,
    color: '#C04040',
    fontWeight: '600',
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 10,
    backgroundColor: COLORS.white,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  bigBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  restoreBig: {
    backgroundColor: COLORS.kiss,
  },
  deleteBig: {
    backgroundColor: '#FFEEEE',
    borderWidth: 1,
    borderColor: '#E07070',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  bigBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.white,
  },
  deleteBigText: {
    color: '#C04040',
  },
});
