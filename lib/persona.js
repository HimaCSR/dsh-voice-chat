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
 * The section carries a name of its own. The harness rejects a second
 * registration under a name it already holds in the same layer — it throws
 * "prompt section ... is already registered" and takes the whole host down —
 * and the deployment persona suffix belongs to the built-in persona plugin.
 * A scoped section could shadow it, but this plugin lives in the global
 * layer, so the only safe shape is a separate section placed right after
 * the built-in one: the configured persona then reads as the more specific
 * instruction, placed after the general one.
 */

/**
 * The prompt section name this plugin owns.
 *
 * It is deliberately not the deployment persona suffix: that name is held by
 * the built-in persona plugin, and sharing it would abort the host on start.
 */
export const PERSONA_SECTION = 'voice-chat:persona-suffix';

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
 *
 * A registration that the harness rejects is reported the same way: a
 * persona that cannot be placed must not take the host down with it.
 *
 * The section's text is a function, not a string. The harness assembles the
 * prompt afresh on every model step, so reading the persona at that moment
 * means an edit shows up on the next reply without re-registering anything.
 * Re-registering would be wrong twice over: a second registration under the
 * same name is refused outright, and doing it from a later callback means
 * creating an effect on a context that may already be gone — either way the
 * host refuses to start.
 * @param ctx - the plugin context.
 * @param readPersona - returns the persona text as it stands right now.
 * @returns `{ applied, reason, dispose }`.
 */
export function registerPersona(ctx, readPersona) {
  const systemPrompt = ctx.get('systemPrompt');
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    return { applied: false, reason: '当前运行时没有系统提示服务，人设未生效', dispose: null };
  }
  // Sit right behind the built-in persona so the more specific instruction
  // is the one read last.
  let order = 10201;
  if (typeof systemPrompt.getSectionOrder === 'function') {
    try {
      const builtIn = systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX');
      if (Number.isFinite(builtIn)) order = builtIn + 1;
    } catch {
      // The placement name is unknown here; the default order stands.
    }
  }
  try {
    const dispose = systemPrompt.section({
      name: PERSONA_SECTION,
      order,
      text: () => buildPersonaSection(readPersona()),
      // The persona is plain instruction text; it names no prompt variable.
      interpolate: false,
    });
    return { applied: true, reason: null, dispose };
  } catch (error) {
    return { applied: false, reason: `人设注入失败：${error?.message ?? error}`, dispose: null };
  }
}
