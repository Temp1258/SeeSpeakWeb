import { Platform } from 'react-native';

// Lightweight device descriptor used at register/login so the server's
// /api/sessions endpoint can label each row with something the user
// recognises ("Steve 的 iPhone", "iPad Pro · iPadOS 17.2"). We
// deliberately avoid adding `expo-device` here — `Platform` alone gives
// enough for a human-meaningful label, and the user can rename their
// device later from Settings if a richer label is needed.

export interface DeviceInfo {
  name: string;
  model: string | null;
  os: string;
  app_version: string | null;
}

export function getDeviceInfo(): DeviceInfo {
  const osLabel = Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS;
  return {
    name: defaultDeviceName(),
    model: null,
    os: `${osLabel} ${Platform.Version}`,
    app_version: null,
  };
}

// Pick a placeholder device name from platform alone. Users in Settings
// can later rename to "客厅 iPad" / "工作机" / etc.
function defaultDeviceName(): string {
  if (Platform.OS === 'ios') {
    // RN doesn't expose isPad directly; safer to surface a generic name
    // and let the user rename. Keeps this util dep-free.
    return 'iPhone';
  }
  if (Platform.OS === 'android') return 'Android Phone';
  return 'Device';
}
