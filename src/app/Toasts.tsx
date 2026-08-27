import { useEffect } from 'react';
import { useUiStore } from '@/state/uiStore';

const TOAST_LIFETIME_MS = 5000;

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);

  useEffect(() => {
    if (toasts.length === 0) return;
    const newest = toasts[toasts.length - 1];
    if (!newest) return;
    const timer = setTimeout(() => dismissToast(newest.id), TOAST_LIFETIME_MS);
    return () => clearTimeout(timer);
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
