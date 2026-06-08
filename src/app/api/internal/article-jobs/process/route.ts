import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { verifyBearerToken } from '@/lib/sync/auth';
import { writeAuditLog } from '@/lib/sync/audit';
import { buildErrorResponse, type ErrorCode } from '@/lib/sync/errors';
import { processArticleJobs } from '@/lib/triggers/process-jobs';

/**
 * POST /api/internal/article-jobs/process  (T10 MOXIE-23 / AC-3)
 *
 * cron worker 入口:消费 moxie_article_jobs 里 pending 任务 → 调 T8 生成草稿。
 * Bearer Token 鉴权(env LATEMAI_INTERNAL_TOKEN),同 T6 /api/internal/articles。
 * 可选 body: { "limit": 5 }。
 */

export const runtime = 'nodejs';
// 每条 job 调一次 LLM 长文(~数十秒)。maxDuration=60 兼容 Vercel Hobby 上限;
// 一次只处理小批(cron 传 limit=3),万一仍超时,worker 的「卡死回收」会下次补上。
export const maxDuration = 60;

export async function GET() {
  return methodNotAllowed();
}

function methodNotAllowed() {
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
  let summaryForAudit = '';

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

    // 可选 limit
    let limit: number | undefined;
    try {
      const raw = await req.text();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.limit === 'number' && parsed.limit > 0) limit = Math.min(parsed.limit, 20);
      }
    } catch {
      // body 可选,解析失败忽略
    }

    const summary = await processArticleJobs({ limit }, { sb });
    summaryForAudit = `picked=${summary.picked} done=${summary.done} failed=${summary.failed} skipped=${summary.skipped}`;

    return NextResponse.json(
      { ok: true, request_id: requestId, data: summary },
      { status: 200 },
    );
  } catch (e) {
    errorCode = 'INTERNAL_ERROR';
    httpStatus = 500;
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[/api/internal/article-jobs/process] fatal', msg);
    const { body, status } = buildErrorResponse(errorCode, 'internal server error', { requestId });
    return NextResponse.json(body, { status });
  } finally {
    if (sb) {
      await writeAuditLog(sb, {
        source: 'sync_api',
        endpoint: '/api/internal/article-jobs/process',
        httpMethod: 'POST',
        httpStatus,
        targetType: 'article_job',
        targetId: null,
        targetNaturalKey: null,
        tokenFingerprint: tokenFp,
        payloadRaw: summaryForAudit,
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
