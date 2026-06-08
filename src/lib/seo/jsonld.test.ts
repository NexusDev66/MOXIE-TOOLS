import { describe, it, expect } from 'vitest';
import { buildArticleJsonLd, buildSoftwareApplicationJsonLd, jsonLdScript } from './jsonld';

describe('buildArticleJsonLd', () => {
  it('必填字段齐全', () => {
    const ld = buildArticleJsonLd({ title: 'T', url: 'https://x.com/articles/a', brandName: 'Moxie' });
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('Article');
    expect(ld.headline).toBe('T');
    expect(ld.author).toEqual({ '@type': 'Organization', name: 'Moxie' });
    expect(ld.publisher).toEqual({ '@type': 'Organization', name: 'Moxie' });
    expect(ld.mainEntityOfPage).toEqual({ '@type': 'WebPage', '@id': 'https://x.com/articles/a' });
  });

  it('可选字段:有则带、无则省', () => {
    const full = buildArticleJsonLd({
      title: 'T', url: 'u', brandName: 'M',
      description: '摘要', imageUrl: 'https://x.com/c.png', publishedAt: '2026-06-01T00:00:00Z',
    });
    expect(full.description).toBe('摘要');
    expect(full.image).toEqual(['https://x.com/c.png']);
    expect(full.datePublished).toBe('2026-06-01T00:00:00Z');
    expect(full.dateModified).toBe('2026-06-01T00:00:00Z');

    const bare = buildArticleJsonLd({ title: 'T', url: 'u', brandName: 'M', description: null, imageUrl: null, publishedAt: null });
    expect('description' in bare).toBe(false);
    expect('image' in bare).toBe(false);
    expect('datePublished' in bare).toBe(false);
  });
});

describe('buildSoftwareApplicationJsonLd', () => {
  it('必填字段齐全', () => {
    const ld = buildSoftwareApplicationJsonLd({ name: 'Cursor', url: 'https://x.com/tools/cursor' });
    expect(ld['@type']).toBe('SoftwareApplication');
    expect(ld.name).toBe('Cursor');
    expect(ld.url).toBe('https://x.com/tools/cursor');
    expect(ld.applicationCategory).toBe('BusinessApplication'); // 缺 category 用默认
    expect(ld.operatingSystem).toBe('Web');
  });

  it('category 传了用传的', () => {
    const ld = buildSoftwareApplicationJsonLd({ name: 'X', url: 'u', category: '编程开发' });
    expect(ld.applicationCategory).toBe('编程开发');
  });

  it('免费/免费档 → 输出 Offer price 0;付费 → 不输出 offers', () => {
    expect(buildSoftwareApplicationJsonLd({ name: 'X', url: 'u', pricing: 'free' }).offers)
      .toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'USD' });
    expect(buildSoftwareApplicationJsonLd({ name: 'X', url: 'u', pricing: 'freemium' }).offers)
      .toBeTruthy();
    expect('offers' in buildSoftwareApplicationJsonLd({ name: 'X', url: 'u', pricing: 'paid' })).toBe(false);
  });
});

describe('jsonLdScript', () => {
  it('转义 < > & 防 </script> 逃逸', () => {
    const s = jsonLdScript({ headline: 'evil</script><script>alert(1)</script>' });
    expect(s).not.toContain('</script>');
    expect(s).not.toContain('<script>');
    expect(s).toContain('\\u003c');         // < 被转义
    // 仍是合法 JSON(把转义还原后能解析)
    expect(() => JSON.parse(s)).not.toThrow();
  });

  it('正常对象可被解析回来', () => {
    const obj = buildArticleJsonLd({ title: 'Hello', url: 'u', brandName: 'M' });
    expect(JSON.parse(jsonLdScript(obj))['@type']).toBe('Article');
  });
});
