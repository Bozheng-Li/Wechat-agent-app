import { readPrompt } from '../loader.mjs';

/** Positive interaction rules shared by public conversation and social replies. */
export const NATURAL_CONVERSATION_SKILL = readPrompt('personas/conversation-skill.md');
