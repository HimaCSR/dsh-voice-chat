/**
 * Conversation persona injection.
 *
 * The persona answers "how does the assistant talk, and what does it say?" —
 * it shapes the content of the reply, not the sound of the voice. The voice
 * side lives in the TTS instruction.
 *
 * It reaches the model through the harness' own system prompt service rather
 * than through a chat message, because `session.prompt` carries no system
 * role: its content is limited to text, image and file parts. Registering a
 * prompt section is the supported way to add standing instructions.
 *
 * The section reuses the deployment persona suffix slot. Sharing a name is
 * deliberate: the harness replaces a section registered under a name it
 * already knows, so a persona configured here overrides the default instead
 * of piling a second persona on top of it.
 */

/**
 * The prompt section name this plugin owns.
 *
 * It matches the deployment persona suffix so the configured persona
 * replaces the default rather than duplicating it.
 */
export const PERSONA_SECTION = 'deployment:persona-suffix';

/**
 * The default persona, written the way the user asked for it: answer one
 * question at a time, and summarize when the answer would otherwise be long.
 */
export const DEFAULT_PERSONA = [
  '这是语音对话：用户问一句，你答一句，不要长篇大论。',
  '如果回答的内容比较多，先用一两句话把要点讲清楚，然后可以补充一句类似「你可以看看我总结的内容」的引导。',
].join('\n');

/**
 * Build the text of the prompt section.
 *
 * The persona is written by the user, often in Chinese, so it is kept
 * verbatim and only framed by an English instruction that tells the model the
 * conversation is spoken aloud.
 * @param persona - the user's persona text.
 * @returns the section text, or an empty string when there is no persona.
 */
export function buildPersonaSection(persona) {
  const text = String(persona ?? '').trim();
  if (text === '') return '';
  return [
    'The conversation is conducted by voice: the user speaks a request and hears the reply read aloud.',
    'Follow the persona below when deciding what to say and how much of it to say.',
    '',
    text,
  ].join('\n');
}

/**
 * Register the persona as a system prompt section.
 *
 * The harness may have no system prompt service at all — a headless or
 * partially booted tree — in which case the persona simply cannot be
 * applied and the caller is told so instead of being handed an error.
 * @param ctx - the plugin context.
 * @param persona - the user's persona text.
 * @returns `{ applied, reason }`.
 */
export function applyPersona(ctx, persona) {
  const systemPrompt = ctx.get('systemPrompt');
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    return { applied: false, reason: '当前运行时没有系统提示服务，人设未生效' };
  }
  const text = buildPersonaSection(persona);
  if (text === '') {
    return { applied: false, reason: '人设为空' };
  }
  const order = typeof systemPrompt.getSectionOrder === 'function'
    ? systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
    : 10200;
  const dispose = systemPrompt.section({ name: PERSONA_SECTION, order, text });
  return { applied: true, reason: null, dispose };
}
