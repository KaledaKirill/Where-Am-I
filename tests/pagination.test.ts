import { describe, expect, it } from 'vitest';
import { parsePage, renderListPage } from '../src/bot/pagination.js';
import { escapeHtml } from '../src/bot/formatting.js';
import { current } from './fixtures.js';
import type { CityGroup } from '../src/domain/models.js';

function group(count: number, name = current.display_name): CityGroup {
  return { place_key: current.place_key, label: 'Берлин, Германия',
    users: Array.from({ length: count }, (_, i) => ({ ...current, user_id: String(i + 1), display_name: name })) };
}

describe('list pagination', () => {
  it('renders an empty list without buttons', () => {
    const page = renderListPage([]);
    expect(page.text).toContain('Пока никто не отметился');
    expect(page.keyboard.inline_keyboard).toEqual([]);
  });

  it('renders 500 unique participants in pages of at most 20 with repeated city headers', () => {
    const groups = [group(500)];
    const pages = Array.from({ length: renderListPage(groups).totalPages }, (_, i) => renderListPage(groups, i));
    const ids = pages.flatMap((page) => [...page.text.matchAll(/tg:\/\/user\?id=(\d+)/g)].map((m) => m[1]));
    expect(pages).toHaveLength(25);
    expect(new Set(ids).size).toBe(500);
    expect(ids).toHaveLength(500);
    for (const page of pages) {
      expect((page.text.match(/tg:\/\/user/g) ?? []).length).toBeLessThanOrEqual(20);
      expect(page.text).toContain('Берлин, Германия — 500');
      expect(page.text.length).toBeLessThanOrEqual(4096);
    }
    expect(pages[0]?.keyboard.inline_keyboard[0]).toEqual([{ text: 'Далее →', callback_data: 'list:1' }]);
    expect(pages.at(-1)?.keyboard.inline_keyboard[0]).toEqual([{ text: '← Назад', callback_data: 'list:23' }]);
  });

  it('escapes and truncates hostile long names and headers without exceeding message limits', () => {
    const groups = [group(60, '<&"\'😀'.repeat(500))];
    groups[0]!.label = '<&"\'😀'.repeat(500);
    const first = renderListPage(groups);
    expect(first.totalPages).toBeGreaterThan(3);
    for (let i = 0; i < first.totalPages; i++) {
      const page = renderListPage(groups, i);
      expect(page.text.length).toBeLessThanOrEqual(4096);
      expect(page.text).toContain('&lt;&amp;&quot;&#39;😀');
      expect(page.text).not.toContain('<&');
      expect(page.text).not.toContain('\ud83d…');
    }
    expect(escapeHtml('<script>"&\'</script>')).toBe('&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;');
  });

  it('clamps a stale page index', () => {
    expect(renderListPage([group(1)], 999).index).toBe(0);
  });

  it.each(['list:-1', 'list:NaN', 'list:01', 'list:1.5', 'list:9999999999', 'other:1', 'list:1\n'])('rejects callback %j', (value) => {
    expect(parsePage(value)).toBeNull();
  });
});
