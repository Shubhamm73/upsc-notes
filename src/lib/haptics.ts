/**
 * Optional haptics (0.15, Settings → Pen & touch, off by default). One short pulse, 8–20 ms, on a pen mark,
 * a rating, Mark reviewed and a streak milestone. Silent where the browser has no vibration (iPad, desktop).
 */
import { hapticsOn } from './prefs';

export const PULSE = { mark: 8, rate: 12, reviewed: 15, milestone: 20 } as const;

export function buzz(kind: keyof typeof PULSE) {
  if (!hapticsOn()) return;
  try {
    navigator.vibrate?.(PULSE[kind]);
  } catch {
    /* no vibration on this device */
  }
}
