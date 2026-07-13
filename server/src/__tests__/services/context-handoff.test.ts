import { describe, it, expect, beforeEach } from 'vitest';
import { maybeInjectContextHandoff, recordSuccessfulModel, recordIncomingMessages, hasPriorModel, _clearStoreForTesting } from '../../services/context-handoff.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

const msgs: ChatMessage[] = [
  { role: 'user', content: 'help me build a scraper' },
  { role: 'assistant', content: 'sure, what site?' },
  { role: 'user', content: 'example.com' },
];

describe('context-handoff', () => {
  beforeEach(() => _clearStoreForTesting());

  it('mode off → never injects, fully inert', () => {
    recordSuccessfulModel({ sessionKey: 'session:s1', modelKey: 'groq/a' });
    const r = maybeInjectContextHandoff({ mode: 'off', sessionKey: 'session:s1', messages: msgs, selectedModelKey: 'google/b' });
    expect(r.injected).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  it('injects one system message ONLY when the model changed', () => {
    recordIncomingMessages('session:s1', msgs);
    recordSuccessfulModel({ sessionKey: 'session:s1', modelKey: 'groq/a' });
    // same model → no injection
    const same = maybeInjectContextHandoff({ mode: 'on_model_switch', sessionKey: 'session:s1', messages: msgs, selectedModelKey: 'groq/a' });
    expect(same.injected).toBe(false);
    // different model → inject
    const diff = maybeInjectContextHandoff({ mode: 'on_model_switch', sessionKey: 'session:s1', messages: msgs, selectedModelKey: 'google/b' });
    expect(diff.injected).toBe(true);
    expect(diff.messages.length).toBe(msgs.length + 1);
    const sys = diff.messages.find(m => m.role === 'system');
    expect(typeof sys?.content === 'string' && sys.content.startsWith('FreeLLMAPI context handoff:')).toBe(true);
  });

  it('does not double-inject if a handoff message already present', () => {
    recordSuccessfulModel({ sessionKey: 'session:s1', modelKey: 'groq/a' });
    const withHandoff: ChatMessage[] = [{ role: 'system', content: 'FreeLLMAPI context handoff:\n…' }, ...msgs];
    const r = maybeInjectContextHandoff({ mode: 'on_model_switch', sessionKey: 'session:s1', messages: withHandoff, selectedModelKey: 'google/b' });
    expect(r.injected).toBe(false);
  });

  it('clears prior model when a fresh (no-assistant) conversation reuses the key', () => {
    recordSuccessfulModel({ sessionKey: 'session:s1', modelKey: 'groq/a' });
    expect(hasPriorModel('session:s1')).toBe(true);
    recordIncomingMessages('session:s1', [{ role: 'user', content: 'brand new question' }]);
    expect(hasPriorModel('session:s1')).toBe(false);
  });
});
