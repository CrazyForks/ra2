import type { ReactNode } from 'react';
import './ra2menu.css';

/** The 800x600 menu artwork anchors the header, command column, and content. */
export function Ra2MenuPanel({ children }: { children: ReactNode }) {
  return (
    <div className="ra2-panel-wrap">
      <div className="ra2-panel">{children}</div>
    </div>
  );
}
