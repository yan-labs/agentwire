import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const qa = z.object({ q: z.string(), a: z.string() });

export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
    schema: z.object({
      title: z.string(),
      description: z.string(),
      lede: z.string().optional(),
      updated: z.string().default('2026-10-26'),
    }),
  }),
  pages: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
    schema: z.object({
      kind: z.enum(['landing', 'legal']),
      title: z.string(),
      description: z.string(),
      h1: z.string().optional(),
      eyebrow: z.string().optional(),
      lede: z.string().optional(),
      updated: z.string().default('2026-10-26'),
      faq: z.array(qa).optional(),
      related: z.array(z.string()).optional(),
    }),
  }),
};
