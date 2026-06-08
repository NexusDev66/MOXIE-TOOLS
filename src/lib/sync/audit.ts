import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * audit_logs 写入助手。
 *
 * 设计:
 *   - 入参就是一次 request 完整的元数据 + 结果
 *   - payload 不存原文，只存 sha256 + 大小（防 PII / 节省空间）
 *   - 失败时**不抛错**，只 console.error —— 审计失败不能让业务请求 fail
 *   - 写入走 service_role client（由 caller 注入），绕 RLS
 */

export interface AuditRecord {
  source: 'sync_api' | 'admin_ui' | 'scanner';
  endpoint: string;
  httpMethod: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  httpStatus: number;

  targetType?: 'product' | 'article' | 'candidate' | 'article_job' | null;
  targetId?: number | null;
  targetNaturalKey?: string | null;

  tokenFingerprint?: string | null;

  payloadRaw?: string | null;          // 用来算 hash，不入库
  payloadBytes?: number | null;

  latencyMs: number;
  errorCode?: string | null;
  errorMessage?: string | null;

  requestId?: string | null;
  userAgent?: string | null;
}

export async function writeAuditLog(
  sb: SupabaseClient,
  rec: AuditRecord,
): Promise<void> {
  const payloadSha = rec.payloadRaw
    ? createHash('sha256').update(rec.payloadRaw).digest('hex')
    : null;
  const errorMessage = rec.errorMessage
    ? rec.errorMessage.slice(0, 500)
    : null;

  const row = {
    source: rec.source,
    endpoint: rec.endpoint,
    http_method: rec.httpMethod,
    http_status: rec.httpStatus,
    target_type: rec.targetType ?? null,
    target_id: rec.targetId ?? null,
    target_natural_key: rec.targetNaturalKey ?? null,
    token_fingerprint: rec.tokenFingerprint ?? null,
    payload_sha256: payloadSha,
    payload_bytes: rec.payloadBytes ?? null,
    latency_ms: rec.latencyMs,
    error_code: rec.errorCode ?? null,
    error_message: errorMessage,
    request_id: rec.requestId ?? null,
    user_agent: rec.userAgent ?? null,
  };

  const { error } = await sb.from('moxie_audit_logs').insert(row);
  if (error) {
    // 审计写入失败不该阻塞业务；记日志后吞掉
    console.error('[audit] write failed', error.message, { endpoint: rec.endpoint });
  }
}
