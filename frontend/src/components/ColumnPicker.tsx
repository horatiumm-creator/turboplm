import { Button, Checkbox, Divider, Dropdown, Space, Tooltip, Typography } from 'antd';
import { TableOutlined } from '@ant-design/icons';

export interface ColumnPickerItem {
  key: string;
  label: string;
  /** Columns that carry the row's identity. Shown ticked and disabled, never hideable. */
  locked?: boolean;
}

/**
 * Show/hide control for a table's columns.
 *
 * A wide table is not improved by being told to scroll. Different readers want genuinely
 * different subsets of a BOM — a buyer reads Notes and Category, a planner reads Effectivity
 * and Qty, and neither wants the other's columns taking space — so the useful control is
 * subtraction, not a scrollbar.
 *
 * Identity columns are locked rather than omitted from the list. Leaving them out invites the
 * reader to wonder whether the control is broken; showing them ticked and disabled says
 * "this one is not yours to remove" without them having to try.
 *
 * The count in the label is deliberate. A hidden column is invisible by definition, and a
 * user who hid three of them last week has no way to tell that a table is incomplete — the
 * badge is the only thing standing between them and reading a partial BOM as a whole one.
 */
export function ColumnPicker({
  items,
  hidden,
  onToggle,
}: {
  items: ColumnPickerItem[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string, visible: boolean) => void;
}) {
  const hiddenCount = items.filter((item) => !item.locked && hidden.has(item.key)).length;

  const panel = (
    <div
      style={{
        background: 'var(--ant-color-bg-elevated, #fff)',
        borderRadius: 8,
        boxShadow: '0 6px 16px rgba(0, 0, 0, 0.12)',
        padding: '10px 14px',
        maxHeight: 360,
        overflowY: 'auto',
      }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Columns to show
      </Typography.Text>
      <Divider style={{ margin: '8px 0' }} />
      <Space direction="vertical" size={6}>
        {items.map((item) => (
          <Checkbox
            key={item.key}
            checked={item.locked || !hidden.has(item.key)}
            disabled={item.locked}
            onChange={(e) => onToggle(item.key, e.target.checked)}
          >
            {item.label}
          </Checkbox>
        ))}
      </Space>
    </div>
  );

  return (
    <Dropdown trigger={['click']} dropdownRender={() => panel} placement="bottomRight">
      <Tooltip title="Choose which columns to show">
        <Button icon={<TableOutlined />}>
          Columns{hiddenCount > 0 ? ` (${items.length - hiddenCount}/${items.length})` : ''}
        </Button>
      </Tooltip>
    </Dropdown>
  );
}
