import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { validateProductPayload, type ProductPayload } from '@/lib/sync/validate';
import { loadCategoryMap } from '@/lib/sync/products';
import { scoreCandidate, type CandidateForScoring } from '@/lib/scoring/completeness';
import { executePromote, type ExecutePromoteResult } from './promote-core';

/**
 * 完善度阈值 → 自动 promote（T11 MOXIE-24 / AC-2,3）
 *
 * cron 扫 pending candidates,completeness 分 >= 阈值 → 自动拼 product payload →
 * validateProductPayload 兜底 → executePromote(复用人工同一条路)。
 *
 * 阈值:env CANDIDATE_AUTO_PROMOTE_THRESHOLD(0–100,默认 70)。
 * payload 由 candidate + ai_enrichment 派生:slug/name/domain 必填可得,
 * tagline 截 features,description = features+use_cases,price_label 取 pricing。
 * 没有类目(enrichment 无 category)→ 自动升级的产品 category 留空,admin 后续可补。
 */

export const DEFAULT_AUTO_PROMOTE_THRESHOLD = 70;
const DEFAULT_SCAN_LIMIT = 30;
const CANDIDATE_FIELDS =
  'id, tool_name_hint, tool_domain, tool_url, occurrence_count, ai_enrichment_jsonb, screenshot_url';

export function autoPromoteThreshold(): number {
  const raw = process.env.CANDIDATE_AUTO_PROMOTE_THRESHOLD;
  // 注意:空串 Number('')===0 会被当合法阈值 0 → 全量自动升级,必须先挡掉
  if (raw == null || raw.trim() === '') return DEFAULT_AUTO_PROMOTE_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_AUTO_PROMOTE_THRESHOLD;
}

export interface AutoPromoteCandidate extends CandidateForScoring {
  id: number;
  tool_url: string;
}

/** 小写、非字母数字转 -、去首尾 -、截断;对齐 promote-form 的 suggestSlug */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

function deriveSlug(name: string, domain: string): string {
  return slugify(name) || slugify(domain.split('.')[0] ?? '') || slugify(domain);
}

/** 截一句话 tagline(≤30):取 features 第一句,退而用 name */
function shortTagline(features: string, fallback: string): string {
  const firstSentence = features.split(/[。！？\n]/)[0]?.trim();
  const base = (firstSentence || features.trim() || fallback).trim();
  return base.slice(0, 30).trim() || fallback.slice(0, 30).trim();
}

export type BuildPayloadResult =
  | { ok: true; payload: ProductPayload }
  | { ok: false; reason: string };

/**
 * 从 candidate + ai_enrichment 派生 product payload。
 * 仅做映射;合法性交给 validateProductPayload(caller 调用)。
 */
export function buildAutoPromotePayload(c: AutoPromoteCandidate): BuildPayloadResult {
  const ai = c.ai_enrichment_jsonb;
  const name = (c.tool_name_hint ?? '').trim() || c.tool_domain;
  const domain = (c.tool_domain ?? '').trim().toLowerCase();
  if (!domain) return { ok: false, reason: '无 domain' };

  const slug = deriveSlug(name, domain);
  if (!slug) return { ok: false, reason: '无法派生 slug' };

  const features = typeof ai?.features === 'string' && ai.features.trim() !== '未知' ? ai.features.trim() : '';
  const useCases = typeof ai?.use_cases === 'string' && ai.use_cases.trim() !== '未知' ? ai.use_cases.trim() : '';
  const tagline = shortTagline(features, name);
  if (!tagline) return { ok: false, reason: '无法派生 tagline' };

  const description = [features, useCases].filter(Boolean).join('\n\n').slice(0, 1500) || undefined;

  const pricingRaw = typeof ai?.pricing === 'string' && ai.pricing.trim() !== '未知' ? ai.pricing.trim() : '';
  const price_label = pricingRaw ? pricingRaw.slice(0, 30) : undefined;

  // tech_stack 里短词(≤8 字符)拿来当 tags(validate 限每项 ≤8、≤8 项)
  const tags = Array.isArray(ai?.tech_stack)
    ? ai.tech_stack.filter((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= 8).slice(0, 8)
    : [];

  const payload: ProductPayload = {
    slug,
    name: name.slice(0, 60),
    domain,
    tagline,
    ...(description ? { description } : {}),
    ...(price_label ? { price_label } : {}),
    ...(tags.length ? { tags } : {}),
    source: { auto_promote: true, candidate_id: c.id },
  };
  return { ok: true, payload };
}

export interface AutoPromoteOutcome {
  candidateId: number;
  score: number;
  status: 'promoted' | 'skipped' | 'failed';
  productId?: number;
  reason?: string;
}

export interface AutoPromoteSummary {
  scanned: number;
  threshold: number;
  promoted: number;
  skipped: number;
  failed: number;
  outcomes: AutoPromoteOutcome[];
}

export interface AutoPromoteDeps {
  sb?: SupabaseClient;
  /** 注入便于测试;默认真实 executePromote */
  promote?: (
    sb: SupabaseClient,
    p: { candidateId: number; payload: ProductPayload; categoryMap?: Map<string, number>; onExistingDomain?: 'update' | 'link' },
  ) => Promise<ExecutePromoteResult>;
}

export async function autoPromoteCandidates(
  opts: { threshold?: number; limit?: number } = {},
  deps: AutoPromoteDeps = {},
): Promise<AutoPromoteSummary> {
  const sb = deps.sb ?? getSupabaseAdminClient();
  const promote = deps.promote ?? executePromote;
  const threshold = opts.threshold ?? autoPromoteThreshold();
  const limit = opts.limit ?? DEFAULT_SCAN_LIMIT;

  // 排序:有 AI 补全的候选优先(只有它们够得到阈值;否则无补全的高频候选会占满 limit
  // 把够格的挤出扫描窗口、每日同序重复永远轮不到)。其次按跨站频次。
  const { data, error } = await sb
    .from('moxie_trend_candidates')
    .select(CANDIDATE_FIELDS)
    .eq('status', 'pending')
    .order('ai_enriched_at', { ascending: false, nullsFirst: false })
    .order('occurrence_count', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`读取候选失败: ${error.message}`);
  const candidates = (data ?? []) as AutoPromoteCandidate[];

  // category map 预加载一次,传给每次 promote(自动升级不带类目,但 core 仍需要它)
  const categoryMap = await loadCategoryMap(sb);

  const summary: AutoPromoteSummary = {
    scanned: candidates.length,
    threshold,
    promoted: 0,
    skipped: 0,
    failed: 0,
    outcomes: [],
  };

  for (const c of candidates) {
    const { score } = scoreCandidate(c);
    if (score < threshold) {
      summary.skipped++;
      summary.outcomes.push({ candidateId: c.id, score, status: 'skipped', reason: `未达阈值(${score}/${threshold})` });
      continue;
    }

    const built = buildAutoPromotePayload(c);
    if (!built.ok) {
      summary.skipped++;
      summary.outcomes.push({ candidateId: c.id, score, status: 'skipped', reason: built.reason });
      continue;
    }

    // 兜底闸门:派生的 payload 必须过 T2 校验,否则不升级
    const validation = validateProductPayload(built.payload);
    if (!validation.ok) {
      summary.skipped++;
      summary.outcomes.push({ candidateId: c.id, score, status: 'skipped', reason: `payload 校验失败 ${validation.error.field}: ${validation.error.message}` });
      continue;
    }

    // onExistingDomain='link':domain 已存在则只链接、不覆盖人工维护的产品(复审 #13)
    const res = await promote(sb, { candidateId: c.id, payload: validation.payload, categoryMap, onExistingDomain: 'link' });
    if (res.ok) {
      summary.promoted++;
      summary.outcomes.push({
        candidateId: c.id,
        score,
        status: 'promoted',
        productId: res.productId,
        ...(res.linkedExisting ? { reason: '域已存在,已链接现有产品(未覆盖)' } : {}),
      });
    } else {
      summary.failed++;
      summary.outcomes.push({ candidateId: c.id, score, status: 'failed', reason: res.error });
    }
  }

  return summary;
}
