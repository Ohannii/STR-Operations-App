import { clsx, type ClassValue } from 'clsx'

/**
 * Tiny classname helper. Use everywhere we conditionally compose
 * Tailwind utility strings. Wraps clsx so we can swap in
 * tailwind-merge later if utility conflicts start hurting.
 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}
