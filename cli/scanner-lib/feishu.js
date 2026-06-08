/**
 * 飞书告警（T4 AC-4）
 *
 * 失败计数器：同一来源连续失败累积，达到阈值（默认 3）发一条飞书告警。
 * webhook URL 从 env FEISHU_WEBHOOK 读，没配则只打 log 不发（CI 里靠 secret 注入）。
 *
 * 飞书自定义机器人 webhook 消息格式（text 类型）：
 *   POST <webhook> { "msg_type": "text", "content": { "text": "..." } }
 */

const FAIL_THRESHOLD = 3;

/** source -> 连续失败次数 */
const failCounts = new Map();

/**
 * 记一次失败。达到阈值返回 true（表示已触发告警）。
 * @param {string} source
 * @param {string} reason
 * @param {(msg:string)=>void} [log]
 * @returns {Promise<boolean>} 是否触发了告警
 */
export async function recordFailure(source, reason, log = () => {}) {
  const n = (failCounts.get(source) ?? 0) + 1;
  failCounts.set(source, n);
  log(`    ⚠ ${source} 第 ${n} 次失败: ${reason}`);

  if (n >= FAIL_THRESHOLD) {
    await sendFeishuAlert(
      `🛰 MOXIE Trend Scanner 告警\n来源 ${source} 连续失败 ${n} 次\n最近原因: ${reason}`,
      log,
    );
    failCounts.set(source, 0); // 告警后清零，避免刷屏
    return true;
  }
  return false;
}

/** 成功时清零失败计数 */
export function recordSuccess(source) {
  failCounts.set(source, 0);
}

/**
 * 直接发一条飞书文本告警。webhook 没配则 log 跳过。
 * @param {string} text
 * @param {(msg:string)=>void} [log]
 * @returns {Promise<boolean>} 是否真的发出去了
 */
export async function sendFeishuAlert(text, log = () => {}) {
  const webhook = process.env.FEISHU_WEBHOOK;
  if (!webhook) {
    log(`    [feishu] FEISHU_WEBHOOK 未配，跳过告警（内容: ${text.replace(/\n/g, ' / ')}）`);
    return false;
  }
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
    });
    if (!res.ok) {
      log(`    [feishu] 发送失败 HTTP ${res.status}`);
      return false;
    }
    log(`    [feishu] 告警已发`);
    return true;
  } catch (e) {
    log(`    [feishu] 发送异常: ${e.message}`);
    return false;
  }
}

export const FEISHU_FAIL_THRESHOLD = FAIL_THRESHOLD;

/** 测试用 */
export function _resetFailCounts() {
  failCounts.clear();
}
