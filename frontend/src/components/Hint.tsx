import { InfoCircleOutlined } from '@ant-design/icons';
import { Popover, Typography } from 'antd';
import type { ReactNode } from 'react';

/**
 * Contextual help behind an icon, instead of a banner that is always on screen.
 *
 * The pattern this replaces: a full-width Alert explaining something the reader mostly
 * already knows, rendered every single time regardless of whether they wanted it. Those
 * boxes are read once and skipped forever after, and worse, they teach people to skip the
 * region they sit in — which is how a genuinely important notice ends up unread because it
 * looked like the four advisory boxes above it.
 *
 * An icon costs one character of space and the explanation is one hover away, so the detail
 * is still there for whoever wants it on the day they want it.
 *
 * WHEN NOT TO USE THIS. Anything the reader must see BEFORE acting — a destructive
 * consequence, a warning that a click cannot be undone — stays visible. Help that is only
 * discoverable by hovering is help that a hurried person never sees, and "they could have
 * hovered" is no defence for data they did not mean to hide. For those, keep one short
 * visible line and put the elaboration in here.
 */
export function Hint({
  children,
  title,
  /** Nudges the icon up a touch when it follows heading text rather than body text. */
  align = 'baseline',
}: {
  children: ReactNode;
  title?: string;
  align?: 'baseline' | 'middle';
}) {
  return (
    <Popover
      content={
        <div style={{ maxWidth: 320 }}>
          <Typography.Paragraph style={{ margin: 0, fontSize: 13 }}>
            {children}
          </Typography.Paragraph>
        </div>
      }
      title={title}
      trigger={['hover', 'click']}
      placement="topLeft"
    >
      {/*
        Focusable and labelled, because a hover-only affordance is invisible to a keyboard
        and to a screen reader — which would turn "the help is one hover away" into "the
        help does not exist" for anyone not using a mouse.
      */}
      <InfoCircleOutlined
        role="button"
        tabIndex={0}
        aria-label={title ? `Help: ${title}` : 'More information'}
        style={{
          marginLeft: 6,
          color: 'rgba(0,0,0,0.45)',
          cursor: 'help',
          verticalAlign: align === 'middle' ? 'middle' : 'baseline',
        }}
      />
    </Popover>
  );
}
