'use client';

import { useActionState, useState } from 'react';
import {
  promoteCandidate,
  dismissCandidate,
  enrichCandidate,
  captureCandidateCover,
  recheckCandidate,
  type PromoteState,
  type EnrichState,
  type CoverState,
  type RecheckState,
} from './actions';
import type { AiEnrichment } from '@/lib/enrichment/prompt';
import type { EnrichMeta } from '@/lib/enrichment/enrich';

const PRICE_LABELS = ['免费', '订阅', '按量', '邀请制', '免费+订阅', '不详'];
const DOMESTIC = [
  { v: 'yes', label: '✅ 国内可用' },
  { v: 'partial', label: '⚠️ 需翻墙/受限' },
  { v: 'no', label: '❌ 不可用' },
];

const empty: PromoteState = {};

type StoredEnrichment = AiEnrichment & { _meta?: EnrichMeta };

export interface CandidateVm {
  id: number;
  name: string;        // tool_name_hint ?? product_key
  domain: string;
  url: string;
  occurrence: number;
  enrichment?: StoredEnrichment;   // 已有的 AI 补全（DB ai_enrichment_jsonb）
  enrichedAt?: string;
  screenshotUrl?: string;          // T9 已截图（DB screenshot_url）
  score?: number;                  // T11 完善度分（0-100）
  threshold?: number;              // T11 自动 promote 阈值
}

export interface CategoryVm {
  id: number;
  slug: string;
  name: string;
}

/** 从产品名生成 slug 建议：小写、空格转 -、去非法字符 */
function suggestSlug(name: string, domain: string): string {
  const base = (name || domain.split('.')[0] || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, 40) || 'tool';
}

export function PromoteForm({
  candidate,
  categories,
}: {
  candidate: CandidateVm;
  categories: CategoryVm[];
}) {
  const [open, setOpen] = useState(false);

  const boundPromote = promoteCandidate.bind(null, candidate.id);
  const [promoteState, promoteAction, promoting] = useActionState(boundPromote, empty);

  const boundDismiss = dismissCandidate.bind(null, candidate.id);
  const [dismissState, dismissAction, dismissing] = useActionState(boundDismiss, empty);

  // AI 补全：初始 state 用 DB 里已有的（有就直接展示，不用重跑）
  const initialEnrich: EnrichState = candidate.enrichment
    ? { ok: true, enrichment: candidate.enrichment, meta: candidate.enrichment._meta }
    : {};
  const boundEnrich = enrichCandidate.bind(null, candidate.id);
  const [enrichState, enrichAction, enriching] = useActionState(boundEnrich, initialEnrich);

  // T9 自动配图:初始 state 用 DB 已有截图
  const initialCover: CoverState = candidate.screenshotUrl
    ? { ok: true, coverUrl: candidate.screenshotUrl }
    : {};
  const boundCapture = captureCandidateCover.bind(null, candidate.id);
  const [coverState, coverAction, capturing] = useActionState(boundCapture, initialCover);

  // T11 再次校验:重算完善度,达阈值即自动升级
  const boundRecheck = recheckCandidate.bind(null, candidate.id);
  const [recheckState, recheckAction, rechecking] = useActionState<RecheckState, FormData>(boundRecheck, {});

  const meetsThreshold =
    candidate.score != null && candidate.threshold != null && candidate.score >= candidate.threshold;

  // description / tags 受控 —— 让「采纳」能把 AI 结果填进去
  const [descVal, setDescVal] = useState('');
  const [tagsVal, setTagsVal] = useState('');

  const ai = enrichState.enrichment;

  // promote 成功后这条 candidate 会从 pending 列表消失（revalidate），不用本地隐藏

  // 防御：scanner 现已 new URL() 拒非 http(s) scheme，这里再加一层白名单防 future 人工导入/DB 直改 leak
  const safeUrl =
    candidate.url.startsWith('http://') || candidate.url.startsWith('https://')
      ? candidate.url
      : '#';

  return (
    <div className="border-t border-border">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <div className="font-medium flex items-center gap-2 flex-wrap">
            {candidate.name}
            {candidate.score != null && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded border ${
                  meetsThreshold
                    ? 'border-emerald-300 text-emerald-700 bg-emerald-50'
                    : 'border-amber-300 text-amber-700 bg-amber-50'
                }`}
                title="完善度分;达阈值可自动升级"
              >
                完善度 {candidate.score}
                {candidate.threshold != null ? `/${candidate.threshold}` : ''}
              </span>
            )}
            {candidate.enrichedAt && (
              <span className="text-xs text-emerald-600" title={`AI 补全于 ${candidate.enrichedAt}`}>
                🤖 已补全
              </span>
            )}
          </div>
          <div className="text-xs text-muted">
            <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
              {candidate.domain}
            </a>
            {' · '}
            {candidate.occurrence} 个源
          </div>
          {(recheckState.message || recheckState.error) && (
            <div className={`text-xs mt-1 ${recheckState.error ? 'text-rose-500' : 'text-emerald-600'}`}>
              {recheckState.error ?? recheckState.message}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <form action={recheckAction}>
            <button
              type="submit"
              disabled={rechecking}
              className="px-3 py-1.5 rounded-md border border-indigo-300 text-indigo-700 hover:bg-indigo-50 text-sm disabled:opacity-50"
              title="重算完善度,达阈值则自动升级"
            >
              {rechecking ? '校验中…' : '再次校验'}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="px-3 py-1.5 rounded-md border border-border hover:border-foreground/40 text-sm"
          >
            {open ? '收起' : '升级 →'}
          </button>
        </div>
      </div>

      {open && (
        <div className="px-4 pb-4 space-y-4 bg-card/50">
          {/* ── AI 一键补全面板（T5） ── */}
          <div className="rounded-md border border-border bg-background/40 p-3 space-y-3">
            <form action={enrichAction} className="flex items-center gap-3">
              <button
                type="submit"
                disabled={enriching}
                className="px-3 py-1.5 rounded-md border border-indigo-300 text-indigo-700 hover:bg-indigo-50 text-sm disabled:opacity-50"
              >
                {enriching ? '补全中…' : ai ? '🤖 重新补全' : '🤖 AI 一键补全'}
              </button>
              <span className="text-xs text-muted">拉官网 + LLM 抽取 5 字段（功能/场景/定价/技术栈/创始人）</span>
              {enrichState.error && <span className="text-rose-500 text-sm">{enrichState.error}</span>}
            </form>

            {/* ── T9 自动配图 ── */}
            <form action={coverAction} className="flex items-center gap-3">
              <button
                type="submit"
                disabled={capturing}
                className="px-3 py-1.5 rounded-md border border-sky-300 text-sky-700 hover:bg-sky-50 text-sm disabled:opacity-50"
              >
                {capturing ? '截图中…' : coverState.coverUrl ? '📷 重新截图' : '📷 截图'}
              </button>
              <span className="text-xs text-muted">Playwright 截官网首屏(截不到则 OG/favicon),升级时带入产品封面</span>
              {coverState.error && <span className="text-rose-500 text-sm">{coverState.error}</span>}
              {coverState.ok && coverState.coverUrl && (
                <a href={coverState.coverUrl} target="_blank" rel="noopener noreferrer" className="text-emerald-600 text-sm underline">
                  已截图{coverState.source ? `（${coverState.source}）` : ''} ↗
                </a>
              )}
            </form>

            {ai && (
              <div className="space-y-2 text-sm">
                <AiField label="功能" value={ai.features} />
                <AiField label="场景" value={ai.use_cases} />
                <AiField label="定价" value={ai.pricing} />
                <AiField label="技术栈" value={ai.tech_stack.length ? ai.tech_stack.join(', ') : '未知'} />
                <AiField label="创始人" value={ai.founders} />

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setDescVal([ai.features, ai.use_cases].filter(t => t && t !== '未知').join('\n\n').slice(0, 1500))}
                    className="px-2.5 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 text-xs"
                  >
                    ↓ 采纳为描述
                  </button>
                  <button
                    type="button"
                    onClick={() => setTagsVal(ai.tech_stack.join(', '))}
                    disabled={!ai.tech_stack.length}
                    className="px-2.5 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 text-xs disabled:opacity-40"
                  >
                    ↓ 技术栈采纳为标签
                  </button>
                </div>

                {enrichState.meta && (
                  <p className="text-[11px] text-muted pt-1">
                    {enrichState.meta.provider}/{enrichState.meta.model} · {enrichState.meta.prompt_tokens}+{enrichState.meta.completion_tokens} tok · ≈${enrichState.meta.cost_usd.toFixed(5)}
                    {enrichState.meta.truncated && ' · 正文已截断'}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* 升级表单 */}
          <form action={promoteAction} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="slug" name="slug" defaultValue={suggestSlug(candidate.name, candidate.domain)} required />
              <Field label="name" name="name" defaultValue={candidate.name} required />
              <Field label="domain" name="domain" defaultValue={candidate.domain} required />
              <div>
                <label className="block text-sm font-medium mb-1">分类</label>
                <select name="category_slug" className="w-full px-3 py-2 rounded-md border border-border bg-card text-sm">
                  <option value="">（不选）</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.slug}>{c.name} ({c.slug})</option>
                  ))}
                </select>
              </div>
            </div>

            <Field label="tagline (≤30 字)" name="tagline" required placeholder="一句话说清做什么+卖点" />
            <Field
              label="description (选填，≤1500)"
              name="description"
              textarea
              value={descVal}
              onChange={setDescVal}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">价格</label>
                <select name="price_label" defaultValue="不详" className="w-full px-3 py-2 rounded-md border border-border bg-card text-sm">
                  {PRICE_LABELS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">国内可用性</label>
                <div className="flex flex-wrap gap-2 pt-1.5">
                  {DOMESTIC.map(d => (
                    <label key={d.v} className="flex items-center gap-1 text-xs">
                      <input type="radio" name="domestic_available" value={d.v} defaultChecked={d.v === 'partial'} />
                      {d.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <Field
              label="标签 (逗号分隔, 3-5 个)"
              name="tags"
              placeholder="编程, IDE, Claude"
              value={tagsVal}
              onChange={setTagsVal}
            />

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={promoting}
                className="px-4 py-2 rounded-md bg-emerald-600 text-white font-medium text-sm disabled:opacity-50"
              >
                {promoting ? '升级中…' : '✅ 升级到产品库'}
              </button>
              {promoteState.error && <span className="text-rose-500 text-sm">{promoteState.error}</span>}
              {promoteState.ok && <span className="text-emerald-600 text-sm">{promoteState.message}</span>}
            </div>
          </form>

          {/* 跳过 */}
          <form action={dismissAction} className="flex items-center gap-2 pt-2 border-t border-border">
            <input
              name="reason"
              placeholder="跳过原因（可选）"
              className="flex-1 px-3 py-1.5 rounded-md border border-border bg-card text-sm"
            />
            <button
              type="submit"
              disabled={dismissing}
              className="px-3 py-1.5 rounded-md border border-rose-300 text-rose-700 hover:bg-rose-50 text-sm disabled:opacity-50"
            >
              {dismissing ? '…' : '跳过'}
            </button>
            {dismissState.error && <span className="text-rose-500 text-xs">{dismissState.error}</span>}
            {dismissState.ok && <span className="text-emerald-600 text-xs">{dismissState.message}</span>}
          </form>
        </div>
      )}
    </div>
  );
}

/** AI 抽取的单个字段展示 */
function AiField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 w-12 text-muted">{label}</span>
      <span className="text-foreground/90 whitespace-pre-wrap">{value}</span>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  required,
  placeholder,
  textarea,
  value,
  onChange,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  textarea?: boolean;
  /** 传了 value/onChange 即受控（采纳功能用） */
  value?: string;
  onChange?: (v: string) => void;
}) {
  const controlled = value !== undefined && onChange !== undefined;
  const common = {
    name,
    required,
    placeholder,
    className: 'w-full px-3 py-2 rounded-md border border-border bg-card text-sm',
  };
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {textarea ? (
        <textarea
          {...common}
          rows={4}
          {...(controlled ? { value, onChange: e => onChange!(e.target.value) } : { defaultValue })}
        />
      ) : (
        <input
          {...common}
          {...(controlled ? { value, onChange: e => onChange!(e.target.value) } : { defaultValue })}
        />
      )}
    </div>
  );
}
