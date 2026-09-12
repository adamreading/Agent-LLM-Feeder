// Classify a model id / display name into a routing MODALITY (models.kind).
// The router serves kind='chat' ONLY (see router.ts), so a non-chat model
// (embedding / tts / rerank / ner / image-gen / moderation) is structurally
// excluded from chat routing rather than relying on a reactive disable.
//
// Best-effort id/name heuristic — mirrors the backfill in drizzle migration
// 0012. A wrong 'chat' guess is still caught downstream (the liveness gate sends
// a real chat completion; a non-chat endpoint errors and stays disabled), and an
// operator can always correct `kind` in the DB. Deliberately CONSERVATIVE: only
// clear non-chat signals flip it, so a normal chat model is never misclassified.
export function classifyModelKind(modelId: string, displayName = ''): string {
  const s = `${modelId} ${displayName}`.toLowerCase();
  if (/gliner|\bpii\b|entity.?extract(ion|or)?|\bner\b/.test(s)) return 'ner';
  if (/rerank/.test(s)) return 'rerank';
  if (/(^|[-/])(embed|embedding|bge|e5|gte|nomic-embed|text-embedding)|\bembed(ding)?\b/.test(s)) return 'embedding';
  // OCR (document → text): a specialty endpoint, not chat. Mistral OCR etc.
  if (/\bocr\b/.test(s)) return 'ocr';
  // TTS (text → speech) BEFORE stt so a "tts" id wins.
  if (/\btts\b|text.?to.?speech|-tts(\b|-)/.test(s)) return 'tts';
  // STT / voice (speech → text, or realtime voice): whisper/transcribe/native-audio.
  // Split out from tts 2026-09-12 (whisper is transcription, not synthesis) and
  // widened to catch the transcribe/native-audio models that were leaking into
  // chat routing + the wiki (gemini-*-transcribe, cohere-transcribe, *-native-audio).
  if (/whisper|transcrib|speech.?to.?text|\bstt\b|native-audio|dictation/.test(s)) return 'stt';
  // Music / audio generation (Google Lyria, MusicGen, AudioGen, Suno). Added
  // 2026-09-11 after Lyria (music) was routed to for 147 creative chat calls.
  if (/lyria|music-?gen|audio-?gen|\bsuno\b/.test(s)) return 'audio_gen';
  // Image generation. The "-image" family (gemini-*-image, gpt-image, firefly,
  // nano-banana) OUTPUTS images — added 2026-09-12; the old list missed the
  // "-image" suffix so ~9 gemini image models sat enabled as chat.
  if (/imagen|image-generation|(^|[-/])image(\b|-)|[-/]image$|flash-image|pro-image|lite-image|firefly|nano-banana|gpt-image|dall-?e|stable-diffusion|\bsdxl\b|\bflux\b|\bveo\b|\bsora\b|text-to-image/.test(s)) return 'image_gen';
  if (/llama-?guard|prompt-?guard|omni-moderation|(^|[-/])moderation/.test(s)) return 'moderation';
  return 'chat';
}
