import { Platform } from 'react-native';
import Constants from 'expo-constants';

// Lightweight device descriptor used at register/login so the server's
// /api/sessions endpoint can label each row with something the user
// recognises ("Steve 的 iPhone", "iPad Pro · iPadOS 17.2"). Pulls the
// human-readable name from expo-constants (UIDevice.name on iOS); on
// iOS 16+ this returns the model ("iPhone") unless the app has the
// user-assigned-device-name entitlement, so we always allow the user
// to override the name from the device list UI.

export interface DeviceInfo {
  name: string;
  model: string | null;
  os: string;
  app_version: string | null;
}

export function getDeviceInfo(): DeviceInfo {
  const idiom = Constants.platform?.ios?.userInterfaceIdiom;
  const isPad = idiom === 'tablet';
  const isMac = idiom === 'desktop';
  const osLabel =
    Platform.OS === 'ios'
      ? isMac ? 'macOS' : isPad ? 'iPadOS' : 'iOS'
      : Platform.OS === 'android' ? 'Android' : Platform.OS;
  const constantsName = (Constants.deviceName ?? '').trim();
  return {
    name: constantsName || defaultDeviceName(isPad, isMac),
    model: null,
    os: `${osLabel} ${Platform.Version}`,
    app_version: null,
  };
}

function defaultDeviceName(isPad: boolean, isMac: boolean): string {
  if (Platform.OS === 'ios') {
    if (isMac) return 'Mac';
    if (isPad) return 'iPad';
    return 'iPhone';
  }
  if (Platform.OS === 'android') return 'Android Phone';
  return 'Device';
}
