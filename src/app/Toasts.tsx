import { useEffect } from 'react';
import { useUiStore } from '@/state/uiStore';

const TOAST_LIFETIME_MS = 5000;

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);

  // One timer per toast: the previous version only ever timed the newest, so
  // an older card could sit on screen indefinitely while new ones arrived.
  useEffect(() => {
    const timers = toasts.map((toast) =>
      setTimeout(() => dismissToast(toast.id), TOAST_LIFETIME_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismissToast]);

  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast ${toast.kind}`}
          onClick={() => dismissToast(toast.id)}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
