import type { Metadata } from 'next';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { PromoteForm, type CandidateVm, type CategoryVm } from './promote-form';
import type { AiEnrichment } from '@/lib/enrichment/prompt';
import type { EnrichMeta } from '@/lib/enrichment/enrich';
import { scoreCandidate } from '@/lib/scoring/completeness';
import { autoPromoteThreshold } from '@/lib/candidates/auto-promote';

export const metadata: Metadata = {
  title: '候选审核',
};

// T9 AC-4:截图 server action 跑 Playwright,给足执行预算防 serverless 超时
export const maxDuration = 60;

const PAGE_SIZE = 50;

type StoredEnrichment = AiEnrichment & { _meta?: EnrichMeta };

interface CandidateRow {
  id: number;
  product_key: string | null;
  tool_url: string;
  tool_domain: string;
  tool_name_hint: string | null;
  occurrence_count: number;
  ai_enrichment_jsonb: StoredEnrichment | null;
  ai_enriched_at: string | null;
  screenshot_url: string | null;
}

export default async function CandidatesPage() {
  // RLS: moxie_trend_candidates 仅 admin 可读（migration_003 policy）
  // admin 已登录 → auth.uid() 解析 → moxie_is_admin() = true → 读得到
  const sb = await getSupabaseServerClient();

  const [{ data: candidates, error }, { data: cats }] = await Promise.all([
    sb
      .from('moxie_trend_candidates')
      .select('id, product_key, tool_url, tool_domain, tool_name_hint, occurrence_count, ai_enrichment_jsonb, ai_enriched_at, screenshot_url')
      .eq('status', 'pending')
      .order('occurrence_count', { ascending: false })
      .order('last_seen_at', { ascending: false })
      .limit(PAGE_SIZE)
      .returns<CandidateRow[]>(),
    sb
      .from('moxie_categories')
      .select('id, slug, name')
      .order('sort_order', { ascending: true })
      .returns<CategoryVm[]>(),
  ]);

  const categories: CategoryVm[] = cats ?? [];
  const threshold = autoPromoteThreshold();

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">候选审核</h1>
        <p className="text-muted text-sm mt-1">
          pending candidates 按跨站频次降序。点"升级"填表 → 写入产品库（status=pending 待上架）。
        </p>
      </header>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50/30 p-4 text-rose-600 text-sm">
          加载失败: {error.message}
        </div>
      ) : !candidates || candidates.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted">
          没有 pending 候选。等 trend-scanner 抓新数据，或都已处理完。
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          {candidates.map(c => {
            const { score } = scoreCandidate({
              tool_name_hint: c.tool_name_hint,
              tool_domain: c.tool_domain,
              occurrence_count: c.occurrence_count,
              ai_enrichment_jsonb: c.ai_enrichment_jsonb,
              screenshot_url: c.screenshot_url,
            });
            const vm: CandidateVm = {
              id: c.id,
              name: c.tool_name_hint ?? c.product_key ?? c.tool_domain,
              domain: c.tool_domain,
              url: c.tool_url,
              occurrence: c.occurrence_count,
              enrichment: c.ai_enrichment_jsonb ?? undefined,
              enrichedAt: c.ai_enriched_at ?? undefined,
              screenshotUrl: c.screenshot_url ?? undefined,
              score,
              threshold,
            };
            return <PromoteForm key={c.id} candidate={vm} categories={categories} />;
          })}
        </div>
      )}

      <p className="text-xs text-muted mt-4">
        显示前 {PAGE_SIZE} 个。candidate 升级后 status 变 promoted，从本列表消失。
      </p>
    </div>
  );
}
