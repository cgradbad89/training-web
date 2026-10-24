import type { ReactNode } from 'react';
/** Never navigate to the normal application from the isolated acceptance UI. */
export default function Link({ children }: { children: ReactNode; href?: string; className?: string }) {
  return <span title="Navigation disabled in the isolated acceptance harness">{children}</span>;
}
