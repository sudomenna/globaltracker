export type EventConfig = {
  canonical: string[];
  custom: string[];
};

export const PAGE_ROLES = [
  'capture',
  'sales',
  'checkout',
  'thankyou',
  'webinar',
  'survey',
] as const;

export type PageRole = (typeof PAGE_ROLES)[number];

export const PAGE_ROLE_DEFAULT_EVENT_CONFIG: Record<PageRole, EventConfig> = {
  capture: { canonical: ['PageView', 'Lead'], custom: [] },
  sales: {
    canonical: ['PageView', 'ViewContent', 'InitiateCheckout'],
    custom: [],
  },
  checkout: { canonical: ['PageView', 'InitiateCheckout'], custom: [] },
  thankyou: { canonical: ['PageView', 'Purchase'], custom: [] },
  webinar: { canonical: ['PageView', 'ViewContent'], custom: [] },
  survey: { canonical: ['PageView'], custom: [] },
};

export const PAGE_ROLE_BADGE_COLOR: Record<PageRole, string> = {
  capture: 'bg-blue-100 text-blue-800',
  sales: 'bg-orange-100 text-orange-800',
  checkout: 'bg-yellow-100 text-yellow-800',
  thankyou: 'bg-green-100 text-green-800',
  webinar: 'bg-purple-100 text-purple-800',
  survey: 'bg-gray-100 text-gray-700',
};
