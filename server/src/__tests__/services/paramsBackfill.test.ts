import { describe, it, expect } from 'vitest';
import { parseParamsB } from '../../services/paramsBackfill.js';

describe('parseParamsB', () => {
  it('reads the total size token, ignoring active-params (aNNb)', () => {
    expect(parseParamsB('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(550);
    expect(parseParamsB('qwen/qwen3-235b-a22b')).toBe(235);
    expect(parseParamsB('gpt-oss-120b')).toBe(120);
    expect(parseParamsB('nemotron-3.5-lightning-30b-a3b')).toBe(30);
  });
  it('handles cloudflare @vendor/ prefixes and decimals', () => {
    expect(parseParamsB('@cf/qwen/qwen3.8-27b')).toBe(27);
    expect(parseParamsB('gemma-4-31b-it')).toBe(31);
  });
  it('multiplies NxMb MoE (Mixtral style)', () => {
    expect(parseParamsB('mixtral-8x22b')).toBe(176);
  });
  it('bails to null on an expert count it cannot total', () => {
    expect(parseParamsB('llama-4-maverick-17b-128e-instruct')).toBeNull();
  });
  it('returns null when the name carries no size token', () => {
    expect(parseParamsB('glm-5.3-flash')).toBeNull();
    expect(parseParamsB('phi-4')).toBeNull();
    expect(parseParamsB('gemini-3.6-flash')).toBeNull();
  });
});
