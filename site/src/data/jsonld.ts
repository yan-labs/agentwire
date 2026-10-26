import { SITE } from '../config';
import type { QA } from './faq';

const ctx = 'https://schema.org';
const abs = (p: string) => (p.startsWith('http') ? p : SITE.url + p);

export const orgLd = () => ({
  '@context': ctx,
  '@type': 'Organization',
  '@id': SITE.url + '/#org',
  name: SITE.name,
  url: SITE.url,
  logo: SITE.url + '/favicon.svg',
  email: SITE.email,
  sameAs: [SITE.github],
});

export const websiteLd = () => ({
  '@context': ctx,
  '@type': 'WebSite',
  '@id': SITE.url + '/#website',
  name: SITE.name,
  url: SITE.url,
  description: SITE.description,
  publisher: { '@id': SITE.url + '/#org' },
  inLanguage: 'en',
});

export const softwareLd = (description: string = SITE.description) => ({
  '@context': ctx,
  '@type': 'SoftwareApplication',
  '@id': SITE.url + '/#app',
  name: SITE.name,
  url: SITE.url,
  description,
  applicationCategory: 'DeveloperApplication',
  applicationSubCategory: 'Messaging API for AI agents',
  operatingSystem: 'Web, any platform that can make HTTP requests',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock', url: SITE.url + '/pricing', description: 'Free with fair-use limits.' },
  publisher: { '@id': SITE.url + '/#org' },
  softwareHelp: { '@type': 'CreativeWork', url: SITE.url + '/docs' },
});

export const faqLd = (items: QA[]) => ({
  '@context': ctx,
  '@type': 'FAQPage',
  mainEntity: items.map((i) => ({ '@type': 'Question', name: i.q, acceptedAnswer: { '@type': 'Answer', text: i.a } })),
});

export const breadcrumbLd = (trail: { name: string; path: string }[]) => ({
  '@context': ctx,
  '@type': 'BreadcrumbList',
  itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: abs(t.path) })),
});

export const techArticleLd = (o: { title: string; description: string; path: string; updated: string }) => ({
  '@context': ctx,
  '@type': 'TechArticle',
  headline: o.title,
  description: o.description,
  url: abs(o.path),
  mainEntityOfPage: abs(o.path),
  dateModified: o.updated,
  datePublished: o.updated,
  inLanguage: 'en',
  author: { '@id': SITE.url + '/#org' },
  publisher: { '@id': SITE.url + '/#org' },
  about: { '@id': SITE.url + '/#app' },
});

export const webPageLd = (o: { title: string; description: string; path: string; updated?: string }) => ({
  '@context': ctx,
  '@type': 'WebPage',
  name: o.title,
  description: o.description,
  url: abs(o.path),
  inLanguage: 'en',
  dateModified: o.updated ?? SITE.updated,
  isPartOf: { '@id': SITE.url + '/#website' },
});
