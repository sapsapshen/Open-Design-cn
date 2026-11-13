import { describe, expect, it } from 'vitest';
import { shouldServeSpaShell } from '../src/spa-shell.js';

describe('shouldServeSpaShell', () => {
  it('serves the shell for client routes, including file names and a trailing slash', () => {
    expect(shouldServeSpaShell('/projects/abc')).toBe(true);
    expect(shouldServeSpaShell('/projects/abc/')).toBe(true);
    expect(shouldServeSpaShell('/projects/abc/files/index.html')).toBe(true);
  });

  it('leaves the root, APIs, artifacts, frames, and Next assets alone', () => {
    expect(shouldServeSpaShell('/')).toBe(false);
    expect(shouldServeSpaShell('/api/health')).toBe(false);
    expect(shouldServeSpaShell('/api')).toBe(false);
    expect(shouldServeSpaShell('/artifacts/demo/index.html')).toBe(false);
    expect(shouldServeSpaShell('/frames/shot.png')).toBe(false);
    expect(shouldServeSpaShell('/_next/static/chunks/app.js')).toBe(false);
  });
});
