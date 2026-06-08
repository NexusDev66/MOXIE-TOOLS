/**
 * 入库 API 错误码定义（对齐 T1 §4.4）
 *
 * T2 (MOXIE-14) 用到的子集 —— 后续 T6 (MOXIE-18 articles) 复用同一套。
 *
 * Response shape（统一）:
 *   {
 *     ok: false,
 *     error: { code, message, field?, request_id? }
 *   }
 */

export type ErrorCode =
  | 'INVALID_PAYLOAD'        // 400 字段缺失 / 类型错 / 长度超限
  | 'UNKNOWN_CATEGORY_SLUG'  // 400 category_slug 不存在
  | 'SLUG_FORMAT'             // 400 slug 不符合 [a-z0-9-]+
  | 'MISSING_TOKEN'           // 401 缺 Authorization header
  | 'INVALID_TOKEN'           // 403 token 不匹配 LATEMAI_INTERNAL_TOKEN
  | 'SLUG_CONFLICT'           // 409 slug 已被另一个 domain 占用
  | 'VALIDATION_FAILED'       // 422 业务校验失败（含禁用词等）
  | 'RATE_LIMITED'            // 429 限流
  | 'INTERNAL_ERROR'          // 500 服务端异常
  | 'METHOD_NOT_ALLOWED';     // 405 用了非 POST

export interface ErrorResponseBody {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    field?: string;
    request_id?: string;
  };
}

export interface SuccessResponseBody<T> {
  ok: true;
  request_id?: string;
  data: T;
}

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_PAYLOAD: 400,
  UNKNOWN_CATEGORY_SLUG: 400,
  SLUG_FORMAT: 400,
  MISSING_TOKEN: 401,
  INVALID_TOKEN: 403,
  SLUG_CONFLICT: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  METHOD_NOT_ALLOWED: 405,
};

/** 给 Response 构造统一 error body */
export function buildErrorResponse(
  code: ErrorCode,
  message: string,
  opts: { field?: string; requestId?: string } = {},
): { body: ErrorResponseBody; status: number } {
  return {
    status: ERROR_HTTP_STATUS[code],
    body: {
      ok: false,
      error: {
        code,
        message,
        ...(opts.field ? { field: opts.field } : {}),
        ...(opts.requestId ? { request_id: opts.requestId } : {}),
      },
    },
  };
}
