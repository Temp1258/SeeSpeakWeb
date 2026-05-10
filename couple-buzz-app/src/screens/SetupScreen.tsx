import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Clipboard,
} from 'react-native';
import { COLORS } from '../constants';
import { api } from '../services/api';
import { storage } from '../utils/storage';

type Step = 'choose' | 'register' | 'login' | 'showId' | 'connect';

interface Props {
  onRegistered: (result: { partner_name: string | null }) => void;
}

export default function SetupScreen({ onRegistered }: Props) {
  const [step, setStep] = useState<Step>('choose');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [loginId, setLoginId] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [myId, setMyId] = useState('');
  const [loading, setLoading] = useState(false);
  const onRegisteredRef = useRef(onRegistered);
  onRegisteredRef.current = onRegistered;

  // Poll for partner pairing while on showId/connect steps
  useEffect(() => {
    if (step !== 'showId' && step !== 'connect') return;

    const poll = setInterval(async () => {
      try {
        const status = await api.getStatus();
        if (status.paired && status.partner_name) {
          clearInterval(poll);
          await storage.setPartnerName(status.partner_name);
          onRegisteredRef.current({ partner_name: status.partner_name });
        }
      } catch {}
    }, 3000);

    return () => clearInterval(poll);
  }, [step]);

  const handleRegister = async () => {
    if (!name.trim()) { Alert.alert('', '请输入昵称'); return; }
    if (password.length < 6) { Alert.alert('', '密码至少6位'); return; }

    setLoading(true);
    try {
      const result = await api.register(name.trim(), password);
      await storage.setUserId(result.user_id);
      await storage.setUserName(name.trim());
      await storage.setTokens(result.access_token, result.refresh_token);
      setMyId(result.user_id);
      setStep('showId');
    } catch (error: any) {
      Alert.alert('注册失败', error.message || '请检查网络连接');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    if (!loginId.trim() || !loginPassword) { Alert.alert('', '请输入 ID 和密码'); return; }

    setLoading(true);
    try {
      const result = await api.login(loginId.trim().toUpperCase(), loginPassword);
      await storage.setUserId(result.user_id);
      await storage.setUserName(result.name);
      await storage.setTokens(result.access_token, result.refresh_token);

      if (result.partner_name) {
        onRegistered({ partner_name: result.partner_name });
      } else {
        setMyId(result.user_id);
        setStep('connect');
      }
    } catch (error: any) {
      Alert.alert('登录失败', error.message || 'ID 或密码错误');
    } finally {
      setLoading(false);
    }
  };

  const handlePair = async () => {
    if (!partnerId.trim()) { Alert.alert('', '请输入对方的 ID'); return; }

    setLoading(true);
    try {
      const result = await api.pair(partnerId.trim().toUpperCase());
      if (result.partner_name) {
        await storage.setPartnerName(result.partner_name);
        onRegistered({ partner_name: result.partner_name });
      }
    } catch (error: any) {
      Alert.alert('连接失败', error.message || '请检查对方 ID');
    } finally {
      setLoading(false);
    }
  };

  const copyId = () => {
    Clipboard.setString(myId);
    Alert.alert('', '已复制 ID');
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>💕</Text>
        <Text style={styles.title}>香宝聚集地</Text>
        <Text style={styles.subtitle}>情侣专属互动</Text>

        {step === 'choose' && (
          <View style={styles.form}>
            <TouchableOpacity style={styles.button} onPress={() => setStep('register')}>
              <Text style={styles.buttonText}>注册新账号</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.buttonOutline} onPress={() => setStep('login')}>
              <Text style={styles.buttonOutlineText}>已有账号，登录</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'register' && (
          <View style={styles.form}>
            <TextInput style={styles.input} placeholder="昵称" placeholderTextColor={COLORS.textLight}
              value={name} onChangeText={setName} maxLength={20} autoFocus />
            <TextInput style={styles.input} placeholder="设置密码（至少6位）" placeholderTextColor={COLORS.textLight}
              value={password} onChangeText={setPassword} secureTextEntry maxLength={32} />
            <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleRegister} disabled={loading}>
              <Text style={styles.buttonText}>{loading ? '注册中...' : '注册'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setStep('choose')}>
              <Text style={styles.link}>返回</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'login' && (
          <View style={styles.form}>
            <TextInput style={styles.input} placeholder="你的 ID（6位）" placeholderTextColor={COLORS.textLight}
              value={loginId} onChangeText={setLoginId} maxLength={6} autoCapitalize="characters" autoFocus />
            <TextInput style={styles.input} placeholder="密码" placeholderTextColor={COLORS.textLight}
              value={loginPassword} onChangeText={setLoginPassword} secureTextEntry maxLength={32} />
            <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleLogin} disabled={loading}>
              <Text style={styles.buttonText}>{loading ? '登录中...' : '登录'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setStep('choose')}>
              <Text style={styles.link}>返回</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'showId' && (
          <View style={styles.form}>
            <Text style={styles.idLabel}>你的 ID</Text>
            <TouchableOpacity style={styles.idBox} onPress={copyId}>
              <Text style={styles.idText}>{myId}</Text>
            </TouchableOpacity>
            <Text style={styles.idHint}>把这个 ID 分享给对方，或点击复制</Text>
            <TouchableOpacity style={styles.button} onPress={() => setStep('connect')}>
              <Text style={styles.buttonText}>去连接对方</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'connect' && (
          <View style={styles.form}>
            {myId ? (
              <Text style={styles.myIdSmall}>我的 ID: {myId}</Text>
            ) : null}
            <TextInput style={styles.input} placeholder="输入对方的 ID（6位）" placeholderTextColor={COLORS.textLight}
              value={partnerId} onChangeText={setPartnerId} maxLength={6} autoCapitalize="characters" autoFocus />
            <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handlePair} disabled={loading}>
              <Text style={styles.buttonText}>{loading ? '连接中...' : '连接'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onRegistered({ partner_name: null })}>
              <Text style={styles.link}>稍后连接</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingVertical: 60,
  },
  logo: {
    fontSize: 64,
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    color: COLORS.textLight,
    marginBottom: 40,
  },
  form: {
    width: '100%',
    gap: 14,
    alignItems: 'center',
  },
  input: {
    width: '100%',
    height: 52,
    backgroundColor: COLORS.white,
    borderRadius: 16,
    paddingHorizontal: 20,
    fontSize: 18,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  button: {
    width: '100%',
    height: 52,
    backgroundColor: COLORS.kiss,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.white,
  },
  buttonOutline: {
    width: '100%',
    height: 52,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  buttonOutlineText: {
    fontSize: 18,
    fontWeight: '500',
    color: COLORS.text,
  },
  link: {
    fontSize: 15,
    color: COLORS.textLight,
    marginTop: 4,
  },
  idLabel: {
    fontSize: 16,
    color: COLORS.textLight,
    marginBottom: 4,
  },
  idBox: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  idText: {
    fontSize: 32,
    fontWeight: '700',
    color: COLORS.kiss,
    letterSpacing: 4,
  },
  idHint: {
    fontSize: 13,
    color: COLORS.textLight,
  },
  myIdSmall: {
    fontSize: 14,
    color: COLORS.textLight,
    marginBottom: 4,
  },
});
