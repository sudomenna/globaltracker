import { z } from 'zod';

export const EventConfigSchema = z.object({
  canonical: z.array(z.string().min(1)),
  custom: z.array(z.string().min(1)),
});

export type EventConfig = z.infer<typeof EventConfigSchema>;
