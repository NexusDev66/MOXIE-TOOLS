import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Bearer Token 校验。
 *
 * 规则:
 *   - 必须有 Authorization header
 *   - 必须是 "Bearer <token>" 形式（大小写不敏感）
 *   - token 与 env LATEMAI_INTERNAL_TOKEN 用 timing-safe 比较（防 timing attack）
 *
 * 不直接抛错，返回 { ok, code? } 让 caller 决定怎么回 HTTP。
 */

export interface TokenCheckResult {
  ok: boolean;
  /** 失败时给出的 error code，调用方映射到 HTTP status */
  code?: 'MISSING_TOKEN' | 'INVALID_TOKEN';
  /** 成功时给出 token fingerprint（sha256 前 12 位），用于审计 */
  fingerprint?: string;
}

const TOKEN_PREFIX = /^bearer\s+/i;

export function verifyBearerToken(authHeader: string | null | undefined): TokenCheckResult {
  if (!authHeader || !TOKEN_PREFIX.test(authHeader)) {
    return { ok: false, code: 'MISSING_TOKEN' };
  }
  const provided = authHeader.replace(TOKEN_PREFIX, '').trim();
  if (!provided) {
    return { ok: false, code: 'MISSING_TOKEN' };
  }

  const expected = process.env.LATEMAI_INTERNAL_TOKEN ?? '';
  if (!expected) {
    // 服务端没配 token —— 不能放任何人进来，但这是配置问题
    // 仍按 INVALID_TOKEN 拒，并在日志层 alert
    return { ok: false, code: 'INVALID_TOKEN' };
  }

  if (!timingSafeStringEquals(provided, expected)) {
    return { ok: false, code: 'INVALID_TOKEN' };
  }

  return { ok: true, fingerprint: tokenFingerprint(provided) };
}

/**
 * timing-safe 字符串比较。
 * 长度不同时直接返 false（已经泄露了长度，但避免逐字符 early-return 泄露内容）。
 */
function timingSafeStringEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** SHA-256 前 12 位 hex，用于审计追溯而不暴露完整 token */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
