import { flushSync } from 'react-dom';

export function withViewTransition(direction, action) {
  if (typeof document === 'undefined' || !document.startViewTransition) {
    action();
    return;
  }
  document.documentElement.dataset.transition = direction;
  const transition = document.startViewTransition(() => {
    flushSync(() => action());
  });
  transition.finished.finally(() => {
    delete document.documentElement.dataset.transition;
  });
}
