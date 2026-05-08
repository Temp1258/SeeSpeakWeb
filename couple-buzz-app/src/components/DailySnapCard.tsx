import React, { useState, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { COLORS, API_URL } from '../constants';
import { api, SnapTodayResponse } from '../services/api';

const URGE_COOLDOWN_MS = 5 * 1000;

const DailySnapCard = forwardRef<{ reload: () => Promise<void> }>((_props, ref) => {
  const [data, setData] = useState<SnapTodayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [urging, setUrging] = useState(false);
  const [reacting, setReacting] = useState(false);

  // Cooldown countdown lives in state — same shape as DailyQuestionCard.
  // Old version computed cooldownLeft from Date.now() in the render body
  // and used a forceTick setState to redraw, which made render impure.
  const [lastUrgeMs, setLastUrgeMs] = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  useEffect(() => {
    if (lastUrgeMs === 0) {
      setCooldownLeft(0);
      return;
    }
    const computeLeft = () => Math.max(0, URGE_COOLDOWN_MS - (Date.now() - lastUrgeMs));
    const initial = computeLeft();
    setCooldownLeft(initial);
    if (initial === 0) return;
    const t = setInterval(() => {
      const left = computeLeft();
      setCooldownLeft(left);
      if (left === 0) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [lastUrgeMs]);
  const inCooldown = cooldownLeft > 0;

  const load = useCallback(async () => {
    try {
      const result = await api.getSnapToday();
      setData(result);
    } catch {}
    setLoading(false);
  }, []);

  useImperativeHandle(ref, () => ({ reload: load }), [load]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleSnap = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('', '需要相机权限');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      cameraType: ImagePicker.CameraType.front,
      quality: 0.3,
      allowsEditing: false,
      exif: false,
    });

    if (result.canceled || !result.assets?.[0]) return;

    setUploading(true);
    try {
      // Goes through api.uploadSnap so a stale access_token (≥15min idle)
      // triggers refresh+retry instead of bouncing the user with "上传失败".
      await api.uploadSnap(result.assets[0].uri);
      await load();
    } catch (e: any) {
      Alert.alert('', e.message || '上传失败');
    }
    setUploading(false);
  };

  if (loading) {
    return (
      <View style={styles.card}>
        <ActivityIndicator color={COLORS.kiss} />
      </View>
    );
  }

  if (!data) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.header}>每日快照 📸</Text>

      <View style={styles.photosRow}>
        <View style={styles.photoBox}>
          <Text style={styles.photoLabel}>我</Text>
          {data.my_photo ? (
            <Image source={{ uri: `${API_URL}${data.my_photo}` }} style={styles.photo} />
          ) : (
            <View style={styles.photoPlaceholder}>
              <Text style={styles.placeholderText}>📷</Text>
            </View>
          )}
          {/* Reaction stamped directly under the photo it's about — ta's
              reaction belongs under MY photo (it's about my snap). Empty
              slot keeps both columns the same vertical height. */}
          <View style={styles.reactionUnderPhoto}>
            {data.my_snapped && data.partner_snapped && data.partner_reaction_to_me ? (
              <View style={styles.reactionInline}>
                <Text style={styles.reactionLabel}>ta 的评价</Text>
                <Text style={styles.reactionEmojiLg}>
                  {data.partner_reaction_to_me === 'up' ? '👍' : '👎'}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
        <View style={styles.photoBox}>
          <Text style={styles.photoLabel}>ta</Text>
          {data.partner_photo ? (
            <Image source={{ uri: `${API_URL}${data.partner_photo}` }} style={styles.photo} />
          ) : (
            <View style={styles.photoPlaceholder}>
              <Text style={styles.placeholderText}>{data.partner_snapped ? '🔒' : '📷'}</Text>
            </View>
          )}
          <View style={styles.reactionUnderPhoto}>
            {data.my_snapped && data.partner_snapped ? (
              data.my_reaction_to_partner ? (
                <View style={styles.reactionInline}>
                  <Text style={styles.reactionLabel}>我的评价</Text>
                  <Text style={styles.reactionEmojiLg}>
                    {data.my_reaction_to_partner === 'up' ? '👍' : '👎'}
                  </Text>
                </View>
              ) : (
                <View style={styles.reactRowInline}>
                  <TouchableOpacity
                    style={[styles.reactBtnInline, styles.reactUp]}
                    onPress={async () => {
                      if (reacting || data.my_reaction_to_partner) return;
                      setReacting(true);
                      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      setData(prev => prev ? { ...prev, my_reaction_to_partner: 'up' } : prev);
                      try { await api.dailyReaction('snap', 'up'); }
                      catch (e: any) { load(); Alert.alert('', e.message || '操作失败'); }
                      finally { setReacting(false); }
                    }}
                    disabled={reacting}
                  >
                    <Text style={styles.reactEmoji}>👍</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.reactBtnInline, styles.reactDown]}
                    onPress={async () => {
                      if (reacting || data.my_reaction_to_partner) return;
                      setReacting(true);
                      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      setData(prev => prev ? { ...prev, my_reaction_to_partner: 'down' } : prev);
                      try { await api.dailyReaction('snap', 'down'); }
                      catch (e: any) { load(); Alert.alert('', e.message || '操作失败'); }
                      finally { setReacting(false); }
                    }}
                    disabled={reacting}
                  >
                    <Text style={styles.reactEmoji}>👎</Text>
                  </TouchableOpacity>
                </View>
              )
            ) : null}
          </View>
        </View>
      </View>

      {!data.my_snapped && (
        <TouchableOpacity
          style={[styles.snapButton, uploading && styles.snapDisabled]}
          onPress={handleSnap}
          disabled={uploading}
        >
          <Text style={styles.snapText}>{uploading ? '上传中...' : '拍一张 📸'}</Text>
        </TouchableOpacity>
      )}

      {data.my_snapped && !data.partner_snapped && (
        <>
          <Text style={styles.waiting}>等待 ta 的快照...</Text>
          <TouchableOpacity
            style={[styles.urgeBtn, (urging || inCooldown) && styles.urgeBtnDisabled]}
            onPress={async () => {
              const now = Date.now();
              if (now - lastUrgeMs < URGE_COOLDOWN_MS) return;
              setUrging(true);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              try {
                await api.urge('snap');
                // Set both atoms in the same handler so the next render
                // reflects the cooldown without a one-frame "⏰ 拍照！"
                // flash while the effect seeds cooldownLeft.
                setLastUrgeMs(Date.now());
                setCooldownLeft(URGE_COOLDOWN_MS);
                Alert.alert('', '已经催 ta 了 ⏰');
              } catch (e: any) {
                Alert.alert('', e.message || '催促失败');
              } finally {
                setUrging(false);
              }
            }}
            disabled={urging || inCooldown}
          >
            <Text style={styles.urgeText}>
              {urging ? '催促中...' : inCooldown ? `${Math.ceil(cooldownLeft / 1000)}s 后可再催` : '⏰ 拍照！'}
            </Text>
          </TouchableOpacity>
        </>
      )}

      {data.my_snapped && data.partner_snapped && (
        <Text style={styles.both}>今天的快照已完成！</Text>
      )}
    </View>
  );
});

export default DailySnapCard;

const styles = StyleSheet.create({
  card: { backgroundColor: COLORS.white, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: COLORS.border },
  header: { fontSize: 13, fontWeight: '600', color: COLORS.textLight, marginBottom: 12 },
  photosRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  photoBox: { flex: 1, alignItems: 'center' },
  photoLabel: { fontSize: 12, fontWeight: '600', color: COLORS.textLight, marginBottom: 6 },
  photo: { width: '100%', aspectRatio: 1, borderRadius: 12 },
  photoPlaceholder: { width: '100%', aspectRatio: 1, borderRadius: 12, backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border, justifyContent: 'center', alignItems: 'center' },
  placeholderText: { fontSize: 28 },
  snapButton: { height: 44, backgroundColor: COLORS.kiss, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  snapDisabled: { opacity: 0.5 },
  snapText: { fontSize: 16, fontWeight: '600', color: COLORS.white },
  waiting: { fontSize: 13, color: COLORS.textLight, textAlign: 'center' },
  both: { fontSize: 13, color: COLORS.kiss, textAlign: 'center', fontWeight: '500' },
  urgeBtn: { height: 44, backgroundColor: COLORS.kiss, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginTop: 12 },
  urgeBtnDisabled: { opacity: 0.4 },
  urgeText: { fontSize: 16, fontWeight: '600', color: COLORS.white },
  // Reaction slot under each photo. Fixed height so both columns stay
  // aligned even when one side has buttons and the other an emoji (or
  // an empty placeholder while ta hasn't reacted yet).
  reactionUnderPhoto: { height: 36, marginTop: 8, justifyContent: 'center', alignItems: 'center' },
  reactionInline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reactionLabel: { fontSize: 12, color: COLORS.textLight, fontWeight: '500' },
  reactionEmojiLg: { fontSize: 24 },
  reactRowInline: { flexDirection: 'row', gap: 8 },
  reactBtnInline: { width: 44, height: 32, borderRadius: 10, justifyContent: 'center', alignItems: 'center', borderWidth: 1 },
  reactUp: { borderColor: '#B8E6CF', backgroundColor: '#F0FBF5' },
  reactDown: { borderColor: '#FFC2C2', backgroundColor: '#FFF0F0' },
  reactEmoji: { fontSize: 18 },
});
