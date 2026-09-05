import { z } from 'zod';
import { NOTIFICATION_CATEGORIES } from '../enums.js';
import { isoDateTimeSchema, jsonObjectSchema, paginationQuerySchema, uuidSchema } from '../common.js';

export const notificationListQuerySchema = paginationQuerySchema.extend({
  unreadOnly: z.coerce.boolean().default(false),
  category: z.enum(NOTIFICATION_CATEGORIES).optional(),
  organizationId: uuidSchema.optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema.nullable(),
  category: z.enum(NOTIFICATION_CATEGORIES),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  data: jsonObjectSchema,
  link: z.string().nullable(),
  readAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type NotificationDto = z.infer<typeof notificationDtoSchema>;
