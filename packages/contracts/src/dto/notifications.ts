import { z } from 'zod';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_DELIVERY_CHANNELS, NOTIFICATION_LOCALES } from '../enums.js';
import { booleanQuerySchema, isoDateTimeSchema, jsonObjectSchema, paginationQuerySchema, uuidSchema } from '../common.js';

export const notificationListQuerySchema = paginationQuerySchema.extend({
  unreadOnly: booleanQuerySchema.default(false),
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

// ----- the recipient's own preferences (HR portal Prompt 8): GET / PUT /me/notification-preferences?organizationId= ------

/** The organisation comes from the query string (never the body) and must be one of the caller's memberships. */
export const notificationPreferencesQuerySchema = z.object({ organizationId: uuidSchema });
export type NotificationPreferencesQuery = z.infer<typeof notificationPreferencesQuerySchema>;

export const notificationPreferenceCellDtoSchema = z.object({
  channel: z.enum(NOTIFICATION_DELIVERY_CHANNELS),
  /** Effective value: the stored preference, else the default (on). Always true for a cell that is not configurable. */
  enabled: z.boolean(),
  /** The member may switch this cell. */
  configurable: z.boolean(),
  /** Notification types of the category delivered on this channel whatever the switch says. */
  alwaysOn: z.array(z.string()),
});
export const notificationPreferenceCategoryDtoSchema = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES),
  /** The category concerns the member (their permissions can make it reach them); the profile hides the others. */
  relevant: z.boolean(),
  channels: z.array(notificationPreferenceCellDtoSchema),
});
export const notificationPreferencesDtoSchema = z.object({
  organizationId: uuidSchema,
  /** The language notifications and e-mails are written in (the member's profile locale). */
  locale: z.enum(NOTIFICATION_LOCALES),
  categories: z.array(notificationPreferenceCategoryDtoSchema),
});
export type NotificationPreferencesDto = z.infer<typeof notificationPreferencesDtoSchema>;
export type NotificationPreferenceCategoryDto = z.infer<typeof notificationPreferenceCategoryDtoSchema>;

/** PUT body: the cells to store (bulk upsert of the caller's own rows; a non-configurable cell is refused). */
export const updateNotificationPreferencesSchema = z.object({
  preferences: z.array(z.object({
    category: z.enum(NOTIFICATION_CATEGORIES),
    channel: z.enum(NOTIFICATION_DELIVERY_CHANNELS),
    enabled: z.boolean(),
  }).strict()).min(1).max(NOTIFICATION_CATEGORIES.length * NOTIFICATION_DELIVERY_CHANNELS.length),
}).strict().refine((v) => new Set(v.preferences.map((p) => `${p.category}:${p.channel}`)).size === v.preferences.length, { message: 'Each category and channel may appear once', path: ['preferences'] });
export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;
