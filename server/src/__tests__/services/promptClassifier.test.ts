import { describe, it, expect } from 'vitest';
import { classifyTier0, latestUserText } from '../../services/promptClassifier.js';

const tc = (text: string, ctx = {}) => classifyTier0(text, ctx).taskClass;

describe('classifyTier0', () => {
  it('classifies coding prompts', () => {
    expect(tc('Write a Python function to reverse a linked list')).toBe('coding');
    expect(tc('Refactor this: def f(x): return x*2')).toBe('coding');
    expect(tc('```js\nconst x = 1\n```\nwhy does this fail?')).toBe('coding');
    expect(tc('Fix the null pointer bug in my Java method')).toBe('coding');
  });

  it('classifies math prompts', () => {
    expect(tc('What is the derivative of 3x^2 + 2x?')).toBe('math');
    expect(tc('Solve for x: 2x + 5 = 15')).toBe('math');
    expect(tc('What is 5 * 27 - 12?')).toBe('math');
    expect(tc('Calculate the square root of 144')).toBe('math');
  });

  it('classifies reasoning prompts', () => {
    expect(tc('Why does the sky appear blue? Explain step by step')).toBe('reasoning');
    expect(tc('Prove that the square root of 2 is irrational')).toBe('math'); // sqrt wins — both are fine routing targets
    expect(tc('Compare and contrast REST and GraphQL')).toBe('reasoning');
  });

  it('classifies creative prompts', () => {
    expect(tc('Write a haiku about the sea')).toBe('creative');
    expect(tc('Compose a short story opening about a lighthouse keeper')).toBe('creative');
  });

  it('classifies trivial greetings only without history', () => {
    expect(tc('hi there')).toBe('trivial');
    expect(tc('thanks!')).toBe('trivial');
    expect(classifyTier0('hi there', { hasHistory: true }).taskClass).toBeNull(); // mid-convo, not trivial
  });

  it('falls through to null (overall) with low confidence when undistinctive', () => {
    const r = classifyTier0("What's the capital of France?");
    expect(r.taskClass).toBeNull();
    expect(r.confidence).toBe('low'); // tier-1 candidate
  });

  it('derives structural needs, NOT task_class, for vision + long context', () => {
    const vision = classifyTier0('what is in this picture', { hasImage: true });
    expect(vision.structuralNeeds).toContain('vision');
    const long = classifyTier0('summarise', { estimatedTokens: 40000 });
    expect(long.structuralNeeds).toContain('long_context');
  });

  it('image with minimal text → vision need, generic ordering', () => {
    const r = classifyTier0('', { hasImage: true });
    expect(r.structuralNeeds).toContain('vision');
    expect(r.taskClass).toBeNull();
  });
});

describe('latestUserText', () => {
  it('returns the last user string message', () => {
    expect(latestUserText([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ])).toBe('second');
  });
  it('flattens multimodal text parts', () => {
    expect(latestUserText([
      { role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: 'x' } }] },
    ])).toBe('describe');
  });
});
