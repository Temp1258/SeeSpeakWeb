import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';

// Show banner + list + sound + badge even when the app is in the foreground.
// Expo SDK 54 replaced `shouldShowAlert` with `shouldShowBanner` / `shouldShowList`;
// we keep `shouldShowAlert` for backward compatibility with older native builds.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function requestPermissions(): Promise<boolean> {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  return finalStatus === 'granted';
}

// Read-only permission status — Settings UI can surface "通知权限：已禁用 ·
// 去 iOS 设置开启" when the user has explicitly denied. Distinct from
// `getDeviceToken() === null`, which conflates "denied" with "transient
// failure" and offers no actionable hint.
export type NotificationPermission = 'granted' | 'denied' | 'undetermined';
export async function getNotificationPermissionStatus(): Promise<NotificationPermission> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    return 'undetermined';
  } catch {
    return 'undetermined';
  }
}

export async function getDeviceToken(): Promise<string | null> {
  if (Platform.OS === 'web') return null;

  try {
    const token = await Notifications.getDevicePushTokenAsync();
    return token.data as string;
  } catch (error) {
    console.warn('Failed to get device push token:', error);
    return null;
  }
}

export async function registerAndUpdateToken(): Promise<void> {
  const hasPermission = await requestPermissions();
  if (!hasPermission) return;

  const token = await getDeviceToken();
  if (!token) return;

  try {
    await api.updateToken(token);
  } catch (error) {
    console.warn('Failed to update device token:', error);
  }
}
