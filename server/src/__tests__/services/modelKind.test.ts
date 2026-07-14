import { describe, it, expect } from 'vitest';
import { classifyModelKind } from '../../services/modelKind.js';

describe('classifyModelKind', () => {
  it('classifies non-chat modalities from id/name', () => {
    expect(classifyModelKind('gliner-pii')).toBe('ner');
    expect(classifyModelKind('nvidia/llama-3.2-nv-rerankqa')).toBe('rerank');
    expect(classifyModelKind('text-embedding-3-large')).toBe('embedding');
    expect(classifyModelKind('baai/bge-m3')).toBe('embedding');
    expect(classifyModelKind('whisper-large-v3')).toBe('tts');
    expect(classifyModelKind('google/imagen-3.0')).toBe('image_gen');
    expect(classifyModelKind('black-forest-labs/flux.1-schnell')).toBe('image_gen');
    expect(classifyModelKind('meta/llama-guard-4-12b')).toBe('moderation');
  });

  it('leaves genuine chat models as chat (conservative — no false non-chat)', () => {
    expect(classifyModelKind('mistralai/mistral-large-3-675b-instruct')).toBe('chat');
    expect(classifyModelKind('deepseek-v3.1')).toBe('chat');
    expect(classifyModelKind('google/gemini-3-flash-preview')).toBe('chat');
    expect(classifyModelKind('gpt-oss-120b')).toBe('chat');
    expect(classifyModelKind('qwen3-coder')).toBe('chat');
    expect(classifyModelKind('llama-4-maverick-17b-128e-instruct')).toBe('chat');
  });
});
