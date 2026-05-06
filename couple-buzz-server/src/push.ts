import apn from '@parse/node-apn';
import path from 'path';
import type { DbOps } from './db';

// Per-token push primitive. Lives here (not in routes.ts) so it has no
// circular dependency on the higher-level fan-out helper below. The
// `deviceToken` is always a single APNs token; multi-device fan-out
// happens in `pushToUser`.
export type SendPushFn = (
  deviceToken: string,
  actionType: string,
  senderName: string,
  extra?: Record<string, string>,
  badge?: number,
  collapseId?: string,
  bodyOverride?: string,
) => Promise<boolean>;

// Reasons that indicate the device token is no longer valid and should be
// evicted from the database so we stop trying to push to it.
// https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
const INVALID_TOKEN_REASONS = new Set([
  'Unregistered',
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
]);

let cleanupDbOps: DbOps | null = null;

const PUSH_MESSAGES: Record<string, { title: string; body: string }> = {
  miss: { title: '💕 想你', body: '{name} 在想你～' },
  finger_heart: { title: '🫰 比心', body: '{name} 给你比了个心' },
  love: { title: '❤️ 爱你', body: '{name} 说爱你！' },
  kiss: { title: '😘 亲亲', body: '{name} 亲了你一下！' },
  poop: { title: '💩 拉屎', body: '{name} 在拉屎哈哈哈' },
  pat: { title: '🫶 拍拍', body: '{name} 拍了拍你～' },
  shy: { title: '😳 害羞', body: '{name} 害羞了～' },
  rose: { title: '🌹 玫瑰', body: '{name} 送你一朵玫瑰' },
  hug: { title: '🤗 抱抱', body: '{name} 想抱抱你～' },
  pick_nose: { title: '🤏 抠鼻屎', body: '{name} 在抠鼻屎...' },
  eat: { title: '🍚 吃饭', body: '{name} 去吃饭啦' },
  angry_silent: { title: '🙉 生气', body: '{name} 生气了，不想听你说话！' },
  angry_talk: { title: '😤 生气', body: '{name} 生气了，但是想听你说话' },
  hungry: { title: '🫠 饿', body: '{name} 饿了～' },
  sleepy: { title: '😴 困', body: '{name} 困了～' },
  where_r_u: { title: '👀 人呢', body: '{name} 在找你！' },
  what_doing: { title: '🧐 在干嘛', body: '{name} 想知道你在干嘛' },
  sleep: { title: '🛌 睡觉', body: '{name} 去睡觉啦' },
  play: { title: '🎮 玩', body: '{name} 在玩～' },  // legacy, kept for old client compat
  phone: { title: '📱 看手机', body: '{name} 在看手机～' },  // legacy, kept for old client compat
  tablet: { title: '📺 看平板', body: '{name} 在看平板～' },
  lazy: { title: '🛋️ 瘫着', body: '{name} 瘫着，懒得动～' },
  red_note: { title: '📕 刷小红书', body: '{name} 在刷小红书呢' },
  audiobook: { title: '🎧 听小说', body: '{name} 在听小说～' },
  board_game: { title: '🎲 桌游', body: '{name} 在玩桌游！' },
  party: { title: '🎉 聚会', body: '{name} 在聚会，玩得开心～' },
  driving: { title: '🚗 开车', body: '{name} 正在开车（注意安全）' },
  riding: { title: '🚌 坐车', body: '{name} 在路上，正在坐车～' },
  meeting: { title: '👥 开会', body: '{name} 在开会，先勿扰' },
  clean: { title: '🧹 打扫卫生', body: '{name} 在打扫卫生' },
  cry: { title: '😢 哭哭', body: '{name} 哭了...' },
  wuwu: { title: '🥺 呜呜', body: '{name} 呜呜呜...' },
  sad: { title: '😫 难过', body: '{name} 难过了' },
  clown: { title: '🤡 小丑', body: '{name} 觉得自己是小丑' },
  haha: { title: '😬 嘻嘻', body: '{name} 在嘻嘻笑～' },
  hehe: { title: '😏 嘿嘿', body: '{name} 嘿嘿嘿...' },
  work: { title: '💻 工作', body: '{name} 在工作' },
  slap: { title: '👋 打你', body: '{name} 打了你一巴掌！' },
  ping: { title: '🛎️ Ping', body: '{name} 按了一下铃！' },
  call_wife: { title: '👰 召唤老婆', body: '{name} 在召唤老婆～' },
  call_husband: { title: '🤵 召唤老公', body: '{name} 在召唤老公～' },
  call_baby: { title: '🍼 召唤宝贝', body: '{name} 在召唤宝贝～' },
  gym: { title: '🏋️ 健身', body: '{name} 在健身，今天也要变强！' },
  milk_tea: { title: '🧋 喝奶茶', body: '{name} 在喝奶茶，馋不馋？' },
  drink: { title: '🥤 喝饮料', body: '{name} 在喝饮料，要不要来一杯？' },
  show_off: { title: '😎 得瑟', body: '{name} 在得瑟，快瞧瞧！' },
  smug: { title: '🤩 得意', body: '{name} 得意得不行～' },  // legacy, kept for old client compat
  praise_me: { title: '🌟 求夸夸', body: '{name} 想要被夸夸！' },
  praise_you: { title: '👍 蒸蚌', body: '{name} 觉得你蒸蚌！' },
  urge_question: { title: '⏰ 催答题', body: '{name} 催你回答今天的每日问答～' },
  urge_snap: { title: '⏰ 催拍照', body: '{name} 催你拍今天的快照～' },
  react_question_up: { title: '👍 收到点赞', body: '{name} 给你今天的答案点了赞' },
  react_question_down: { title: '👎 收到反对', body: '{name} 对你今天的答案表示反对' },
  react_snap_up: { title: '👍 收到点赞', body: '{name} 给你今天的快照点了赞' },
  react_snap_down: { title: '👎 收到反对', body: '{name} 对你今天的快照表示反对' },
  unpair: { title: '💔 已解除配对', body: '{name} 解除了配对' },
  daily_answer: { title: '📝 每日问答', body: '{name} 回答了今天的问题，在等你的答案' },
  daily_both: { title: '📝 每日问答', body: '你们都回答了！快来看看对方的答案' },
  reaction: { title: '💬 回应', body: '{name} 回应了你' },
  ritual_morning: { title: '🌅 早安', body: '{name} 说早安了～' },
  ritual_evening: { title: '🌙 晚安', body: '{name} 说晚安了～' },
  ritual_both_morning: { title: '🌅 早安', body: '你们都说了早安！新的一天一起加油 💪' },
  ritual_both_evening: { title: '🌙 晚安', body: '你们都说了晚安！今天辛苦了 💕' },
  mailbox_open: { title: '📮 次日达', body: '新一场已开启，写点什么给 ta 吧～' },
  mailbox_written: { title: '💌 次日达', body: '{name} 寄出了一封信，等送达时间' },
  mailbox_countdown_15min: { title: '💌 次日达', body: '15 分钟后送达本场的信！' },
  mailbox_reveal: { title: '📮 次日达', body: '本场的信已送达！快来看看 💌' },
  weekly_report: { title: '📊 恋爱周报', body: '本周恋爱报告来了！' },
  capsule_unlock: { title: '💌 择日达', body: '你有一封来自过去的信～' },
  capsule_buried: { title: '💌 择日达', body: '{name} 寄出了一封信，{countdown} 后送达' },
  bucket_new: { title: '📝 新心愿', body: '{name} 添加了一个新心愿' },
  bucket_complete: { title: '✅ 心愿达成', body: '{name} 完成了「{title}」！' },
  date_new: { title: '📅 新纪念日', body: '{name} 添加了一个新纪念日' },
  snap_submitted: { title: '📸 每日快照', body: '{name} 拍了今天的快照，在等你的照片' },
  snap_both: { title: '📸 每日快照', body: '你们都拍了今天的快照！快来看看 💕' },
  sticky_posted: { title: '📝 每日一帖', body: '{name} 贴了一张新便利贴' },
  sticky_appended: { title: '✍️ 每日一帖', body: '{name} 在便利贴上加了几句' },
  weather_sunny: { title: '☀️ 晴天', body: '{name} 那边出太阳啦～' },
  weather_cloudy: { title: '☁️ 多云', body: '{name} 那边多云～' },
  weather_rain: { title: '🌧️ 雨天', body: '{name} 那边下雨啦，记得带伞' },
  weather_thunder: { title: '⚡️ 打雷', body: '{name} 那边打雷啦！' },
  weather_snow: { title: '❄️ 下雪', body: '{name} 那边下雪啦，好浪漫～' },
  touch: { title: '拍臭宝！👏', body: '{name} 想你了！🥹' },
};

let provider: apn.Provider | null = null;

export function initAPNs(dbOps?: DbOps): void {
  if (dbOps) cleanupDbOps = dbOps;

  const keyId = process.env.APN_KEY_ID;
  const teamId = process.env.APN_TEAM_ID;
  const keyPath = process.env.APN_KEY_PATH || './certs/AuthKey.p8';

  if (!keyId || !teamId) {
    console.log('[APNs] Not configured, skipping initialization');
    return;
  }

  try {
    provider = new apn.Provider({
      token: {
        key: path.resolve(keyPath),
        keyId,
        teamId,
      },
      production: process.env.APN_PRODUCTION === 'true',
    });
    console.log('[APNs] Provider initialized');
  } catch (error) {
    console.error('[APNs] Failed to initialize:', error);
    provider = null;
  }
}

export async function sendPush(
  deviceToken: string,
  actionType: string,
  senderName: string,
  extra?: Record<string, string>,
  badge?: number,
  // collapseId: APNs replaces an earlier delivered notification with the same
  // id on the lock screen — used for high-frequency events (touch/pat) so the
  // user sees a single rolling notification instead of N separate ones.
  // bodyOverride: lets the caller render a dynamic body (e.g. "想你了 3 下")
  // that doesn't fit the static {name}/{title} template in PUSH_MESSAGES.
  collapseId?: string,
  bodyOverride?: string
): Promise<boolean> {
  if (!provider) {
    console.error('[APNs] Provider not initialized');
    return false;
  }

  const message = PUSH_MESSAGES[actionType];
  if (!message) {
    console.error(`[APNs] Unknown action type: ${actionType}`);
    return false;
  }

  // Function-form replace so user-controlled values (senderName, bucket
  // titles) can't smuggle `$&` / `$1` / `$$` replacement sequences and warp
  // the rendered push body. Function returns are inserted verbatim.
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let body = bodyOverride ?? message.body.replace(/\{name\}/g, () => senderName);
  if (!bodyOverride && extra) {
    for (const [key, value] of Object.entries(extra)) {
      body = body.replace(new RegExp(`\\{${escapeRe(key)}\\}`, 'g'), () => value);
    }
  }

  const notification = new apn.Notification();
  notification.alert = {
    title: message.title,
    body,
  };
  notification.sound = 'default';
  // Badge reflects total unread items for that user. When undefined we omit
  // the field so APNs leaves the existing icon badge untouched.
  if (typeof badge === 'number') {
    notification.badge = Math.max(0, badge);
  }
  if (collapseId) {
    notification.collapseId = collapseId;
  }
  notification.topic = process.env.APN_BUNDLE_ID || 'com.couplebuzz.app';
  // expo-notifications iOS reads remote-push `data` from userInfo["body"],
  // not the userInfo top level (see EXNotificationSerializer.m). Wrap the
  // custom keys under "body" so the client receives them as `data.*`. Without
  // this, `data` is null on the client and every tap falls back to History.
  notification.payload = { body: { actionType, senderName, ...(extra || {}) } };

  try {
    const result = await provider.send(notification, deviceToken);

    if (result.failed.length > 0) {
      console.error('[APNs] Push failed:', JSON.stringify(result.failed));
      for (const f of result.failed) {
        const reason = f.response?.reason;
        // APNs returns HTTP 410 with reason "Unregistered" once the token is dead.
        if ((reason && INVALID_TOKEN_REASONS.has(reason)) || f.status === 410) {
          cleanupDbOps?.clearDeviceTokenByValue(deviceToken);
          console.log(`[APNs] Evicted stale device token (reason: ${reason ?? f.status})`);
          break;
        }
      }
      return false;
    }

    console.log(`[APNs] Push sent: ${actionType} from ${senderName}`);
    return true;
  } catch (error) {
    console.error('[APNs] Push error:', error);
    return false;
  }
}

// Fans a single logical push out to every device the user has registered.
// No-op when the user has no tokens (push permission denied or never
// opened the app post-install). Uses Promise.allSettled so one slow /
// dead token can't stall the rest — same rationale as scheduler's
// broadcastPush but at user granularity.
//
// Trailing undefineds are stripped before invoking pushFn so the recorded
// call shape matches what call sites used to send directly — keeps
// jest.toHaveBeenCalledWith assertions stable.
export async function pushToUser(
  dbOps: DbOps,
  pushFn: SendPushFn,
  userId: string,
  actionType: string,
  senderName: string,
  extra?: Record<string, string>,
  badge?: number,
  collapseId?: string,
  bodyOverride?: string,
): Promise<void> {
  const tokens = dbOps.getDeviceTokensForUser(userId);
  if (tokens.length === 0) return;
  await Promise.allSettled(
    tokens.map((t) => {
      if (bodyOverride !== undefined) return pushFn(t, actionType, senderName, extra, badge, collapseId, bodyOverride);
      if (collapseId !== undefined) return pushFn(t, actionType, senderName, extra, badge, collapseId);
      if (badge !== undefined) return pushFn(t, actionType, senderName, extra, badge);
      if (extra !== undefined) return pushFn(t, actionType, senderName, extra);
      return pushFn(t, actionType, senderName);
    }),
  );
}
