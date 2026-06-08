import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { verifyBearerToken } from '@/lib/sync/auth';
import { validateProductPayload } from '@/lib/sync/validate';
import {
  upsertProductByDomain,
  loadCategoryMap,
} from '@/lib/sync/products';
import { writeAuditLog } from '@/lib/sync/audit';
import {
  buildErrorResponse,
  type ErrorCode,
} from '@/lib/sync/errors';

/**
 * POST /api/internal/products
 *
 * 由 moxie 内部 worker / admin UI 调用，把审核通过的产品写入 moxie_products。
 *
 * 流程:
 *   1. Bearer Token 校验（env LATEMAI_INTERNAL_TOKEN）
 *   2. JSON body 解析 + 字段校验
 *   3. category_slug 存在性校验
 *   4. ON CONFLICT (domain) DO UPDATE 幂等写入
 *   5. 写 moxie_audit_logs（含 latency / token fingerprint / payload sha256）
 *
 * 响应:
 *   - 201 Created   新 domain，inserted=true
 *   - 200 OK        已有 domain，inserted=false，字段已更新
 *   - 400/401/403/409/500  见 src/lib/sync/errors.ts
 */

export const runtime = 'nodejs';   // 需要 node:crypto timingSafeEqual

// 不允许 GET/PATCH/DELETE/...，全部 405
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
      const { body, status } = buildErrorResponse(
        errorCode,
        'cannot read request body',
        { requestId },
      );
      httpStatus = status;
      return NextResponse.json(body, { status });
    }

    let parsed: unknown;
    try {
      parsed = rawBody.length ? JSON.parse(rawBody) : null;
    } catch {
      errorCode = 'INVALID_PAYLOAD';
      const { body, status } = buildErrorResponse(
        errorCode,
        'request body is not valid JSON',
        { requestId },
      );
      httpStatus = status;
      return NextResponse.json(body, { status });
    }

    // 3. Schema 校验
    const validation = validateProductPayload(parsed);
    if (!validation.ok) {
      errorCode = validation.error.code;
      const { body, status } = buildErrorResponse(
        errorCode,
        validation.error.message,
        { field: validation.error.field, requestId },
      );
      httpStatus = status;
      return NextResponse.json(body, { status });
    }
    const payload = validation.payload;
    targetKey = payload.domain;

    if (!sb) {
      errorCode = 'INTERNAL_ERROR';
      const { body, status } = buildErrorResponse(
        errorCode,
        'database client not configured',
        { requestId },
      );
      httpStatus = status;
      return NextResponse.json(body, { status });
    }

    // 4. category_slug 存在性
    const categoryMap = await loadCategoryMap(sb);
    if (payload.category_slug && !categoryMap.has(payload.category_slug)) {
      errorCode = 'UNKNOWN_CATEGORY_SLUG';
      const { body, status } = buildErrorResponse(
        errorCode,
        `category_slug "${payload.category_slug}" not in moxie_categories`,
        { field: 'category_slug', requestId },
      );
      httpStatus = status;
      return NextResponse.json(body, { status });
    }

    // 5. Upsert
    const result = await upsertProductByDomain(sb, payload, {
      categoryIdBySlug: categoryMap,
    });
    targetId = result.id;
    httpStatus = result.inserted ? 201 : 200;

    return NextResponse.json(
      {
        ok: true,
        request_id: requestId,
        data: {
          id: result.id,
          slug: result.slug,
          domain: payload.domain,
          status: 'pending',
          inserted: result.inserted,
        },
      },
      { status: httpStatus },
    );
  } catch (e) {
    errorCode = 'INTERNAL_ERROR';
    httpStatus = 500;
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[/api/internal/products] fatal', msg);
    const { body, status } = buildErrorResponse(
      errorCode,
      'internal server error',
      { requestId },
    );
    return NextResponse.json(body, { status });
  } finally {
    if (sb) {
      // 审计写入失败不阻塞响应
      await writeAuditLog(sb, {
        source: 'sync_api',
        endpoint: '/api/internal/products',
        httpMethod: 'POST',
        httpStatus,
        targetType: 'product',
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
