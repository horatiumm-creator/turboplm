import { EyeOutlined } from '@ant-design/icons';
import { Tag } from 'antd';
import type { ReactNode } from 'react';
import { Hint } from './Hint';

/**
 * "You are looking, not editing" — as a pill, not a banner.
 *
 * This replaces a full-width Alert that ran across the top of thirteen different pages.
 * The state has to stay visible, because the question it answers is a real one: a viewer
 * who sees no buttons anywhere assumes the page is broken before they assume they lack the
 * role. So the pill is always shown; what moved behind the icon is the sentence explaining
 * which actions are unavailable and what would change that.
 *
 * A pill rather than an icon alone, deliberately. An unlabelled icon at the top of a page
 * is not a status, it is a mystery — the reader has to hover to find out whether anything
 * is even wrong. Two words of label cost almost no space and remove the need to hover at
 * all for the common case.
 *
 * One component rather than thirteen inline copies, so the wording, the icon and the
 * placement cannot drift apart page by page, which is exactly what happened to the Alert
 * it replaces.
 */
export function ReadOnlyNotice({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <Tag icon={<EyeOutlined />} style={{ paddingRight: 4 }}>
        Read-only
        <Hint title="Read-only access" align="middle">
          {children}
        </Hint>
      </Tag>
    </div>
  );
}
