/**
 * Decide whether a chat run should bypass the local agent CLI and call
 * DeepSeek's HTTP API directly.
 *
 * The launch wizard stores a DeepSeek key so API mode can run without a
 * local CLI. That key must not override an explicit choice of another
 * agent: Claude, Codex, Gemini, and the rest still spawn their own
 * binaries. Direct HTTP is only for an explicit DeepSeek agent selection.
 */
export function shouldRouteChatToDeepseekHttp(
  agentId: unknown,
  wizardDeepseekKey: unknown,
): boolean {
  if (typeof wizardDeepseekKey !== 'string' || wizardDeepseekKey.trim().length === 0) {
    return false;
  }
  return typeof agentId === 'string' && agentId.trim().toLowerCase() === 'deepseek';
}
