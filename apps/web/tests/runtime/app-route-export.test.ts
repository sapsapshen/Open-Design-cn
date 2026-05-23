import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';
import { readFileSync } from 'node:fs';
import { generateSpaShellStaticParams } from '../../src/routes/spa-shell-page';

describe('SPA shell export route', () => {
  it('stays compatible with static export builds', () => {
    expect(nextConfig.output).toBe('export');

    const routeSource = readFileSync(new URL('../../app/[[...slug]]/page.tsx', import.meta.url), 'utf8');
    expect(routeSource).not.toMatch(/\bdynamicParams\b/);

    expect(generateSpaShellStaticParams()).toEqual([{ slug: [] }]);
  });
});
