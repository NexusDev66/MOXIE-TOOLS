import { describe, it, expect } from 'vitest';
import { scoreCandidate, type CandidateForScoring } from './completeness';

const fullAi = {
  features: 'AI 原生 IDE,深度集成 Agent',
  use_cases: '给程序员日常写代码用',
  pricing: '免费+订阅',
  founders: 'Anysphere',
  tech_stack: ['VSCode'],
};

const base: CandidateForScoring = {
  tool_name_hint: null,
  tool_domain: 'x.com',
  occurrence_count: 0,
  ai_enrichment_jsonb: null,
  screenshot_url: null,
};

describe('scoreCandidate', () => {
  it('全空候选 → 0 分,missing 列全维度', () => {
    const r = scoreCandidate(base);
    expect(r.score).toBe(0);
    expect(r.missing).toContain('产品名');
    expect(r.missing).toContain('官网截图');
  });

  it('数据齐全 → 满分 100,无 missing', () => {
    const r = scoreCandidate({
      tool_name_hint: 'Cursor',
      tool_domain: 'cursor.com',
      occurrence_count: 3,
      ai_enrichment_jsonb: fullAi,
      screenshot_url: 'https://x/c.png',
    });
    expect(r.score).toBe(100);
    expect(r.missing).toHaveLength(0);
  });

  it('「未知」占位 / 空数组不计分', () => {
    const r = scoreCandidate({
      tool_name_hint: 'X',
      tool_domain: 'x.com',
      occurrence_count: 1,
      ai_enrichment_jsonb: { features: '未知', use_cases: '未知', pricing: '未知', founders: '未知', tech_stack: [] },
      screenshot_url: null,
    });
    // name 15 + occurrence round(1/3*15)=5 = 20;AI 全未知/空 + 无截图 → 0
    expect(r.score).toBe(20);
    expect(r.missing).toContain('AI 功能(features)');
    expect(r.missing).toContain('AI 技术栈(tech_stack)');
  });

  it('occurrence_count 线性封顶 3 个源', () => {
    expect(scoreCandidate({ ...base, occurrence_count: 3 }).breakdown.occurrence).toBe(15);
    expect(scoreCandidate({ ...base, occurrence_count: 10 }).breakdown.occurrence).toBe(15);
    expect(scoreCandidate({ ...base, occurrence_count: 0 }).breakdown.occurrence).toBe(0);
    expect(scoreCandidate({ ...base, occurrence_count: null }).breakdown.occurrence).toBe(0);
  });
});
