import type { UserLimitDto } from '@flowza/contracts';

/** From this share of the user limit in use, the screens that add employees warn before the limit is reached. */
export const USER_LIMIT_WARN_PERCENT = 90;

/** Share of the user limit in use, 0–100 (a limit of 0 is full); null without a limit. */
export function userLimitPercent({ used, limit }: Pick<UserLimitDto, 'used' | 'limit'>): number | null {
  if (limit === null) return null;
  return limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
}
