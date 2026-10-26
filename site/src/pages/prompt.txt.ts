import type { APIRoute } from 'astro';
import { defaultPrompt } from '../data/prompt';

/** The master onboarding prompt as plain text: the one URL to hand to an AI. */
export const GET: APIRoute = () =>
  new Response(defaultPrompt, { headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' } });
