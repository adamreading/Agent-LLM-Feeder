import { describe, it, expect } from 'vitest';
import { classifyModelKind } from '../../services/modelKind.js';

describe('classifyModelKind', () => {
  it('classifies non-chat modalities from id/name', () => {
    expect(classifyModelKind('gliner-pii')).toBe('ner');
    expect(classifyModelKind('nvidia/llama-3.2-nv-rerankqa')).toBe('rerank');
    expect(classifyModelKind('text-embedding-3-large')).toBe('embedding');
    expect(classifyModelKind('baai/bge-m3')).toBe('embedding');
    expect(classifyModelKind('whisper-large-v3')).toBe('stt'); // transcription, not synthesis
    expect(classifyModelKind('google/imagen-3.0')).toBe('image_gen');
    expect(classifyModelKind('black-forest-labs/flux.1-schnell')).toBe('image_gen');
    expect(classifyModelKind('google/lyria-3-pro-preview')).toBe('audio_gen');
    expect(classifyModelKind('lyria-realtime-exp')).toBe('audio_gen');
    // specialist kinds that were leaking into chat (2026-09-12)
    expect(classifyModelKind('gemini-3.1-flash-image')).toBe('image_gen');
    expect(classifyModelKind('gemini-3-pro-image-preview')).toBe('image_gen');
    expect(classifyModelKind('mistral-ocr-4-1')).toBe('ocr');
    expect(classifyModelKind('cohere-transcribe-03-2026')).toBe('stt');
    expect(classifyModelKind('gemini-3.5-transcribe')).toBe('stt');
    expect(classifyModelKind('gemini-2.5-flash-native-audio-latest')).toBe('stt');
    expect(classifyModelKind('@cf/openai/whisper-large-v3-turbo')).toBe('stt');
    expect(classifyModelKind('voxtral-mini-tts-2603')).toBe('tts');
    expect(classifyModelKind('gemini-3.1-flash-tts-preview')).toBe('tts');
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
