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
  if (/\btts\b|whisper|text.?to.?speech|audio-transcri|speech-to-text/.test(s)) return 'tts';
  if (/imagen|image-generation|dall-?e|stable-diffusion|\bflux\b|\bveo\b|\bsora\b|text-to-image/.test(s)) return 'image_gen';
  if (/llama-?guard|prompt-?guard|omni-moderation|(^|[-/])moderation/.test(s)) return 'moderation';
  return 'chat';
}
