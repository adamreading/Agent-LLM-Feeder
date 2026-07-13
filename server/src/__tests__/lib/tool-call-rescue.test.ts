import { describe, it, expect } from 'vitest';
import { rescueInlineToolCalls, containsDialectMarker, startsWithDialectMarker } from '../../lib/tool-call-rescue.js';

const tools = new Set(['get_weather', 'search']);

describe('rescueInlineToolCalls', () => {
  it('rescues Kimi/DeepSeek token dialect', () => {
    const t = '<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city":"Paris"}<|tool_call_end|><|tool_calls_section_end|>';
    const r = rescueInlineToolCalls(t, tools);
    expect(r.detected).toBe(true);
    expect(r.calls?.[0]).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' });
  });

  it('rescues <function=NAME{...}> dialect', () => {
    const r = rescueInlineToolCalls('<function=get_weather{"city":"Rome"}</function>', tools);
    expect(r.detected).toBe(true);
    expect(r.calls?.[0].name).toBe('get_weather');
  });

  it('rescues <tool_call> XML dialect', () => {
    const r = rescueInlineToolCalls('<tool_call>{"name":"search","arguments":{"q":"cats"}}</tool_call>', tools);
    expect(r.detected).toBe(true);
    expect(r.calls?.[0].name).toBe('search');
  });

  it('rescues bare JSON ONLY when it names a known tool (schema-gated)', () => {
    const known = rescueInlineToolCalls('{"name":"get_weather","arguments":{"city":"Oslo"}}', tools);
    expect(known.detected).toBe(true);
    expect(known.calls?.[0].name).toBe('get_weather');
    // arbitrary JSON answer naming no tool must pass through untouched
    const answer = rescueInlineToolCalls('{"result":42}', tools);
    expect(answer.detected).toBe(false);
    expect(answer.calls).toBeNull();
  });

  it('marks a detected-but-unparseable dialect as a DEAD turn (calls=null)', () => {
    const r = rescueInlineToolCalls('<tool_call>{"name":"unknown_tool","arguments":{}}</tool_call>', tools);
    expect(r.detected).toBe(true);
    expect(r.calls).toBeNull(); // caller fails over
  });

  it('leaves ordinary prose untouched', () => {
    const r = rescueInlineToolCalls('The weather in Paris is sunny.', tools);
    expect(r.detected).toBe(false);
    expect(r.calls).toBeNull();
  });

  it('marker detectors work', () => {
    expect(containsDialectMarker('foo <tool_call> bar')).toBe(true);
    expect(containsDialectMarker('plain text')).toBe(false);
    expect(startsWithDialectMarker('  <|tool_call_begin|>x')).toBe(true);
  });
});
