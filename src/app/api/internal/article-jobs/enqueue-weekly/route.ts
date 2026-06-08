import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { verifyBearerToken } from '@/lib/sync/auth';
import { writeAuditLog } from '@/lib/sync/audit';
import { buildErrorResponse, type ErrorCode } from '@/lib/sync/errors';
import { enqueueWeeklyTrend } from '@/lib/triggers/article-enqueue';

/**
 * POST /api/internal/article-jobs/enqueue-weekly  (T10 MOXIE-23 / AC-1 定时路径)
 *
 * 每周一 cron 入口:本周 high-value 产品 → 入队一篇选型趋势文(幂等,同周只一条)。
 * Bearer Token 鉴权(env LATEMAI_INTERNAL_TOKEN)。
 */

export const runtime = 'nodejs';
export const maxDuration = 30;

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

    const result = await enqueueWeeklyTrend(sb);
    auditNote = `enqueued=${result.enqueued} ${result.reason}`;

    return NextResponse.json({ ok: true, request_id: requestId, data: result }, { status: 200 });
  } catch (e) {
    errorCode = 'INTERNAL_ERROR';
    httpStatus = 500;
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[/api/internal/article-jobs/enqueue-weekly] fatal', msg);
    const { body, status } = buildErrorResponse(errorCode, 'internal server error', { requestId });
    return NextResponse.json(body, { status });
  } finally {
    if (sb) {
      await writeAuditLog(sb, {
        source: 'sync_api',
        endpoint: '/api/internal/article-jobs/enqueue-weekly',
        httpMethod: 'POST',
        httpStatus,
        targetType: 'article_job',
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
