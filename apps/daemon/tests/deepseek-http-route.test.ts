import { describe, expect, it } from 'vitest';
import { shouldRouteChatToDeepseekHttp } from '../src/deepseek-http-route.js';

describe('shouldRouteChatToDeepseekHttp', () => {
  it('routes an explicit DeepSeek agent when a wizard key is saved', () => {
    expect(shouldRouteChatToDeepseekHttp('deepseek', 'sk-test')).toBe(true);
    expect(shouldRouteChatToDeepseekHttp('  DeepSeek  ', 'sk-test')).toBe(true);
  });

  it('does not let a saved key override another local agent', () => {
    expect(shouldRouteChatToDeepseekHttp('claude', 'sk-test')).toBe(false);
    expect(shouldRouteChatToDeepseekHttp('codex', 'sk-test')).toBe(false);
    expect(shouldRouteChatToDeepseekHttp('anthropic-api', 'sk-test')).toBe(false);
  });

  it('does not route when the key is missing or blank', () => {
    expect(shouldRouteChatToDeepseekHttp('deepseek', undefined)).toBe(false);
    expect(shouldRouteChatToDeepseekHttp('deepseek', '   ')).toBe(false);
    expect(shouldRouteChatToDeepseekHttp('deepseek', null)).toBe(false);
  });

  it('does not route when no agent was selected', () => {
    expect(shouldRouteChatToDeepseekHttp(undefined, 'sk-test')).toBe(false);
    expect(shouldRouteChatToDeepseekHttp('', 'sk-test')).toBe(false);
  });
});
