/**
 * Which model answers a turn.
 *
 * Most of what is said to JARVIS is a command — "put Sky on", "show me
 * Nvidia", "mute it", "thanks" — and a command needs a tool call and a few
 * words, not a frontier model thinking hard. Those go to the fast model at low
 * effort; everything else keeps the main model. It is a handful of rules, not
 * a model call, so routing itself costs nothing.
 *
 * Unsure means deep: a slow answer to a simple command is a small cost, a thin
 * answer to a real question is not. And anything asking him to reason, write,
 * look or advise is deep however short it is.
 */

/** Asking him to think, write, look or advise — deep whatever the length. */
const DEEP = new RegExp(
  [
    String.raw`\bwhy\b`,
    String.raw`\bexplain`,
    String.raw`\bhow (does|do|did|would|should|could|can|might|is it|are)\b`,
    String.raw`\bwhat (should|would|could|if|do you think|are the|is the difference)\b`,
    String.raw`\bshould (i|we)\b`,
    String.raw`\b(advice|advise|recommend|suggest|opinion|pros and cons|trade-?offs?|weigh)\b`,
    String.raw`\b(write|draft|compose|rewrite|reply|respond|email|message|text)\b`,
    String.raw`\b(summari[sz]e|analy[sz]e|research|investigate|plan|brainstorm|think|reason|figure out|work out)\b`,
    String.raw`\b(debug|code|script|calculate|estimate|translate|teach|story|poem|essay|review|critique)\b`,
    String.raw`\b(look at|what do you see|see me|camera|my screen|screenshot|photo|picture)\b`,
    // "Put Sky on and tell me what they're saying" is a command plus a question.
    String.raw`\b(and|then) (then )?(tell|explain|summari[sz]e|read|describe)\b`,
    String.raw`\btell me (what|about|why|how|more)\b`,
    String.raw`\bwhat (they|he|she|it)('?s| is| are)? saying\b`,
    String.raw`\b(calendar|schedule|meeting|inbox|mail|unread)\b`,
    String.raw`\b(file|folder|terminal|shell|install|run)\b`,
  ].join('|'),
  'i',
)

/** Commands to the interface: the media hub, the globe, the look, memory and alerts. */
const COMMAND =
  /^(ok(ay)?,?\s+|now,?\s+|and\s+|jarvis,?\s+|please,?\s+|can you\s+|could you\s+)*(put|play|show|open|close|hide|switch|go|fly|take me|zoom|turn|mute|unmute|silence|pause|resume|stop|start|expand|collapse|shrink|minimi[sz]e|maximi[sz]e|full ?screen|add|remove|drop|compare|chart|follow|unfollow|set|change|make|bring|back|return|next|previous|scroll|louder|quieter|volume|listen|watch|reset|clear|dim|brighten|remember|forget|no alerts|quiet)\b/i

/** Small talk and acknowledgements. */
const CHATTER =
  /^(thanks|thank you|cheers|ok(ay)?|cool|great|nice|perfect|lovely|brilliant|good (morning|afternoon|evening|night)|morning|hello|hi|hey|yes|yeah|yep|sure|no|nope|never ?mind|that'?s (all|it|fine)|got it|sounds good|well done|good job)\b/i

/** Quick lookups he answers from one tool or the clock. */
const LOOKUP =
  /^(what('?s| is) (the )?(time|date|day)|what (time|day|date) is it|how('?s| is) (\w+ ){0,3}(doing|trading|looking)|what('?s| is) (\w+ ){0,3}(price|trading at|at)\b|where('?s| is) (\w+ ){0,3}trading|what('?s| is) the weather|any (news|headlines)|anything (new|i should know))/i

/** Past this many words it is a question, not a command. */
const MAX_FAST_WORDS = 14

/**
 * @param {string} text what the user said
 * @param {{ tag?: string | null }} [turn]
 * @returns {{ tier: 'fast' | 'deep', why: string }}
 */
export function routeTurn(text, turn = {}) {
  // The morning briefing arrives with its data inline: a summary, not research.
  if (turn.tag === 'briefing') return { tier: 'fast', why: 'briefing' }
  const said = String(text ?? '').trim()
  if (!said) return { tier: 'deep', why: 'empty' }
  if (DEEP.test(said)) return { tier: 'deep', why: 'asks for thought' }
  const words = said.split(/\s+/).length
  if (words > MAX_FAST_WORDS) return { tier: 'deep', why: `${words} words` }
  // One command per turn; "put Sky on and then tell me…" is more than that.
  if (/[.?!;]\s+\S/.test(said.replace(/\b(st|dr|mr|mrs|ms|vs|etc)\./gi, ''))) return { tier: 'deep', why: 'several sentences' }
  if (CHATTER.test(said)) return { tier: 'fast', why: 'small talk' }
  if (LOOKUP.test(said)) return { tier: 'fast', why: 'lookup' }
  if (COMMAND.test(said)) return { tier: 'fast', why: 'command' }
  return { tier: 'deep', why: 'default' }
}
