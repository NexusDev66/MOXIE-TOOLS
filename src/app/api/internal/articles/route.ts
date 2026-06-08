import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { verifyBearerToken } from '@/lib/sync/auth';
import { validateArticlePayload } from '@/lib/sync/article-validate';
import { upsertArticleBySlug } from '@/lib/sync/articles';
import { importArticleImages } from '@/lib/sync/cover-import';
import { writeAuditLog } from '@/lib/sync/audit';
import { buildErrorResponse, type ErrorCode } from '@/lib/sync/errors';

/**
 * POST /api/internal/articles  (T6 MOXIE-18)
 *
 * 把审核通过的文章写入 moxie_articles，按 slug 幂等，含「发布闭环」：
 *   1. Bearer Token 校验（env LATEMAI_INTERNAL_TOKEN）
 *   2. JSON body 解析 + 字段校验
 *   3. cover_url + body_html 内图自动 import 到 moxie-covers Storage，替换链接
 *   4. 按 slug INSERT(全量) / UPDATE(只刷事实字段，保留 status/published_at)
 *   5. 写 moxie_audit_logs
 *
 * 响应:
 *   - 201 Created   新 slug，inserted=true
 *   - 200 OK        已有 slug，inserted=false
 *   - 400/401/403/500  见 src/lib/sync/errors.ts
 */

export const runtime = 'nodejs';
// 图片 import 会同步抓多张外图，给足执行预算（并发5 + 单图8s，最坏约 ≤40s）
export const maxDuration = 60;

export async function GET() {
  return methodNotAllowed();
}
export async function PATCH() {
  return methodNotAllowed();
}
export async function DELETE() {
  return methodNotAllowed();
}
export async function PUT() {
  return methodNotAllowed();
}

function methodNotAllowed() {
  const { body, status } = buildErrorResponse(
    'METHOD_NOT_ALLOWED',
    'Only POST is allowed on this endpoint',
  );
  return NextResponse.json(body, { status, headers: { Allow: 'POST' } });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  const requestId = req.headers.get('x-request-id') || randomUUID();
  const userAgent = req.headers.get('user-agent') ?? null;
  let rawBody = '';
  let tokenFp: string | null = null;
  let errorCode: ErrorCode | null = null;
  let httpStatus = 200;
  let targetId: number | null = null;
  let targetKey: string | null = null;

  const sb = (() => {
    try {
      return getSupabaseAdminClient();
    } catch {
      return null;
    }
  })();

  try {
    // 1. Token
    const auth = verifyBearerToken(req.headers.get('authorization'));
    if (!auth.ok) {
      errorCode = auth.code!;
      const { body, status } = buildErrorResponse(
        errorCode,
        errorCode === 'MISSING_TOKEN'
          ? 'Missing or malformed Authorization header'
          : 'Invalid bearer token',
        { requestId },
      );
      httpStatus = status;
      return NextResponse.json(body, { status });
    }
    tokenFp = auth.fingerprint ?? null;

    // 2. Body parse
    try {
      rawBody = await req.text();
    } catch {
      errorCode = 'INVALID_PAYLOAD';
      const { body, status } = buildErrorResponse(errorCode, 'cannot read request body', { requestId });
      httpStatus = status;
      return NextResponse.json(body, { status });
    }

    let parsed: unknown;
    try {
      parsed = rawBody.length ? JSON.parse(rawBody) : null;
    } catch {
      errorCode = 'INVALID_PAYLOAD';
      const { body, status } = buildErrorResponse(errorCode, 'request body is not valid JSON', { requestId });
      httpStatus = status;
      return NextResponse.json(body, { status });
    }

    // 3. Schema 校验
    const validation = validateArticlePayload(parsed);
    if (!validation.ok) {
      errorCode = validation.error.code;
      const { body, status } = buildErrorResponse(errorCode, validation.error.message, {
        field: validation.error.field,
        requestId,
      });
      httpStatus = status;
      return NextResponse.json(body, { status });
    }
    const payload = validation.payload;
    targetKey = payload.slug;

    if (!sb) {
      errorCode = 'INTERNAL_ERROR';
      const { body, status } = buildErrorResponse(errorCode, 'database client not configured', { requestId });
      httpStatus = status;
      return NextResponse.json(body, { status });
    }

    // 4. 图片 import（AC-4）—— cover_url + body 内图传 Storage，替换链接。失败不阻断。
    let images = { imported: 0, failed: 0, skipped: 0 };
    if (payload.body_html || payload.cover_url) {
      const r = await importArticleImages(sb, {
        slug: payload.slug,
        bodyHtml: payload.body_html ?? null,
        coverUrl: payload.cover_url ?? null,
      });
      if (r.bodyHtml !== null) payload.body_html = r.bodyHtml;
      if (r.coverUrl !== null) payload.cover_url = r.coverUrl;
      images = { imported: r.imported, failed: r.failed, skipped: r.skipped };
    }

    // 5. Upsert by slug
    const result = await upsertArticleBySlug(sb, payload);
    targetId = result.id;
    httpStatus = result.inserted ? 201 : 200;

    // 注:不在此调 Google Indexing API —— 普通 schema.org/Article 不在该 API 支持范围
    // (仅 JobPosting / 直播 VideoObject)。文章收录走 sitemap + Search Console(见 T7 docs)。

    return NextResponse.json(
      {
        ok: true,
        request_id: requestId,
        data: {
          id: result.id,
          slug: result.slug,
          status: result.status,
          inserted: result.inserted,
          images,
        },
      },
      { status: httpStatus },
    );
  } catch (e) {
    errorCode = 'INTERNAL_ERROR';
    httpStatus = 500;
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[/api/internal/articles] fatal', msg);
    const { body, status } = buildErrorResponse(errorCode, 'internal server error', { requestId });
    return NextResponse.json(body, { status });
  } finally {
    if (sb) {
      await writeAuditLog(sb, {
        source: 'sync_api',
        endpoint: '/api/internal/articles',
        httpMethod: 'POST',
        httpStatus,
        targetType: 'article',
        targetId,
        targetNaturalKey: targetKey,
        tokenFingerprint: tokenFp,
        payloadRaw: rawBody,
        payloadBytes: Buffer.byteLength(rawBody, 'utf8'),
        latencyMs: Date.now() - startedAt,
        errorCode,
        errorMessage: null,
        requestId,
        userAgent,
      }).catch(() => undefined);
    }
  }
}
