import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { verifyBearerToken } from '@/lib/sync/auth';
import { writeAuditLog } from '@/lib/sync/audit';
import { buildErrorResponse, type ErrorCode } from '@/lib/sync/errors';
import { autoPromoteCandidates } from '@/lib/candidates/auto-promote';

/**
 * POST /api/internal/candidates/auto-promote  (T11 MOXIE-24 / AC-3)
 *
 * cron 入口:扫 pending candidates,completeness 分 >= 阈值 → 自动升级到 products。
 * Bearer Token 鉴权(env LATEMAI_INTERNAL_TOKEN),同 T6/T10。
 * 可选 body:{ "threshold": 70, "limit": 30 }(覆盖 env 默认)。
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET() {
  const { body, status } = buildErrorResponse('METHOD_NOT_ALLOWED', 'Only POST is allowed on this endpoint');
  return NextResponse.json(body, { status, headers: { Allow: 'POST' } });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  const requestId = req.headers.get('x-request-id') || randomUUID();
  const userAgent = req.headers.get('user-agent') ?? null;
  let tokenFp: string | null = null;
  let errorCode: ErrorCode | null = null;
  let httpStatus = 200;
  let auditNote = '';

  const sb = (() => {
    try {
      return getSupabaseAdminClient();
    } catch {
      return null;
    }
  })();

  try {
    const auth = verifyBearerToken(req.headers.get('authorization'));
    if (!auth.ok) {
      errorCode = auth.code!;
      const { body, status } = buildErrorResponse(
        errorCode,
        errorCode === 'MISSING_TOKEN' ? 'Missing or malformed Authorization header' : 'Invalid bearer token',
        { requestId },
      );
      httpStatus = status;
      return NextResponse.json(body, { status });
    }
    tokenFp = auth.fingerprint ?? null;

    if (!sb) {
      errorCode = 'INTERNAL_ERROR';
      const { body, status } = buildErrorResponse(errorCode, 'database client not configured', { requestId });
      httpStatus = status;
      return NextResponse.json(body, { status });
    }

    // 可选 threshold / limit
    let threshold: number | undefined;
    let limit: number | undefined;
    try {
      const raw = await req.text();
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.threshold === 'number' && p.threshold >= 0 && p.threshold <= 100) threshold = p.threshold;
        if (typeof p.limit === 'number' && p.limit > 0) limit = Math.min(p.limit, 100);
      }
    } catch {
      // body 可选
    }

    const summary = await autoPromoteCandidates({ threshold, limit }, { sb });
    auditNote = `scanned=${summary.scanned} promoted=${summary.promoted} skipped=${summary.skipped} failed=${summary.failed} thr=${summary.threshold}`;

    return NextResponse.json({ ok: true, request_id: requestId, data: summary }, { status: 200 });
  } catch (e) {
    errorCode = 'INTERNAL_ERROR';
    httpStatus = 500;
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[/api/internal/candidates/auto-promote] fatal', msg);
    const { body, status } = buildErrorResponse(errorCode, 'internal server error', { requestId });
    return NextResponse.json(body, { status });
  } finally {
    if (sb) {
      await writeAuditLog(sb, {
        source: 'sync_api',
        endpoint: '/api/internal/candidates/auto-promote',
        httpMethod: 'POST',
        httpStatus,
        targetType: 'candidate',
        targetId: null,
        targetNaturalKey: null,
        tokenFingerprint: tokenFp,
        payloadRaw: auditNote,
        payloadBytes: null,
        latencyMs: Date.now() - startedAt,
        errorCode,
        errorMessage: null,
        requestId,
        userAgent,
      }).catch(() => undefined);
    }
  }
}
