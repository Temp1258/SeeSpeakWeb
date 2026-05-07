import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  USER_ID: 'couple_buzz_user_id',
  PARTNER_ID: 'couple_buzz_partner_id',
  PARTNER_NAME: 'couple_buzz_partner_name',
  USER_NAME: 'couple_buzz_user_name',
  ACCESS_TOKEN: 'couple_buzz_access_token',
  REFRESH_TOKEN: 'couple_buzz_refresh_token',
  TIMEZONE: 'couple_buzz_timezone',
  PARTNER_TIMEZONE: 'couple_buzz_partner_timezone',
  PARTNER_REMARK: 'couple_buzz_partner_remark',
};

// Pre-Step 4 keys that are now server-stored. Kept here only so
// `clearAll` can mop them up on logout — never read or written from app
// code anymore.
const LEGACY_KEYS = [
  'couple_buzz_daily_seen_date',
  'couple_buzz_daily_seen_pa',
  'couple_buzz_daily_seen_ps',
  'couple_buzz_inbox_last_seen',
  'couple_buzz_write_letter_draft',
];

export const storage = {
  async getUserId(): Promise<string | null> {
    return AsyncStorage.getItem(KEYS.USER_ID);
  },

  async setUserId(id: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.USER_ID, id);
  },

  async getPartnerName(): Promise<string | null> {
    return AsyncStorage.getItem(KEYS.PARTNER_NAME);
  },

  async setPartnerName(name: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.PARTNER_NAME, name);
  },

  async getUserName(): Promise<string | null> {
    return AsyncStorage.getItem(KEYS.USER_NAME);
  },

  async setUserName(name: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.USER_NAME, name);
  },

  async getAccessToken(): Promise<string | null> {
    return AsyncStorage.getItem(KEYS.ACCESS_TOKEN);
  },

  async setAccessToken(token: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.ACCESS_TOKEN, token);
  },

  async getRefreshToken(): Promise<string | null> {
    return AsyncStorage.getItem(KEYS.REFRESH_TOKEN);
  },

  async setRefreshToken(token: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.REFRESH_TOKEN, token);
  },

  // Atomic two-token write. AsyncStorage.setItem is per-key; if the JS thread
  // is suspended / the app is killed between two consecutive setItem calls,
  // disk ends up with NEW_ACCESS + OLD_REFRESH. The server already rotated
  // (deleted OLD_REFRESH at response time), so the next refresh dies with 401
  // and the user gets booted to login. multiSet hands both writes to the
  // native module in one batch — far less likely to be torn apart.
  async setTokens(accessToken: string, refreshToken: string): Promise<void> {
    await AsyncStorage.multiSet([
      [KEYS.ACCESS_TOKEN, accessToken],
      [KEYS.REFRESH_TOKEN, refreshToken],
    ]);
  },

  async getTimezone(): Promise<string | null> {
    return AsyncStorage.getItem(KEYS.TIMEZONE);
  },

  async setTimezone(tz: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.TIMEZONE, tz);
  },

  async getPartnerTimezone(): Promise<string | null> {
    return AsyncStorage.getItem(KEYS.PARTNER_TIMEZONE);
  },

  async setPartnerTimezone(tz: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.PARTNER_TIMEZONE, tz);
  },

  async getPartnerRemark(): Promise<string | null> {
    return AsyncStorage.getItem(KEYS.PARTNER_REMARK);
  },

  async setPartnerRemark(remark: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.PARTNER_REMARK, remark);
  },

  async getPartnerId(): Promise<string | null> {
    return AsyncStorage.getItem(KEYS.PARTNER_ID);
  },

  async setPartnerId(id: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.PARTNER_ID, id);
  },

  async clearAll(): Promise<void> {
    // Legacy keys included so a logout / force-revoke wipes any stragglers
    // from before the Step 4 server-side migration.
    await AsyncStorage.multiRemove([...Object.values(KEYS), ...LEGACY_KEYS]);
  },
};
