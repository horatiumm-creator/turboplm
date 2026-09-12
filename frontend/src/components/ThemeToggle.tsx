import { Button, Dropdown, Tooltip } from 'antd';
import { BulbOutlined, DesktopOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { useTheme } from '../theme/ThemeContext';
import type { ThemeMode } from '../theme/ThemeContext';

const OPTIONS: { key: ThemeMode; label: string; icon: JSX.Element }[] = [
  { key: 'light', label: 'Light', icon: <SunOutlined /> },
  { key: 'dark', label: 'Dark', icon: <MoonOutlined /> },
  // Last, and named for what it does rather than "Auto". "System" tells the user where the
  // setting actually lives if they want to change it.
  { key: 'system', label: 'Match system', icon: <DesktopOutlined /> },
];

/**
 * Theme control for the header.
 *
 * The icon shows the theme currently in force, not the one clicking would select. A control
 * that previews its own effect reads as a statement about the present state to about half of
 * people and as a promise about the next state to the other half; showing the present state
 * and putting the choice in an explicit menu removes the guess entirely.
 */
export function ThemeToggle() {
  const { mode, resolved, setMode } = useTheme();
  const icon = mode === 'system' ? <BulbOutlined /> : resolved === 'dark' ? <MoonOutlined /> : <SunOutlined />;

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        selectedKeys: [mode],
        items: OPTIONS.map((o) => ({ key: o.key, icon: o.icon, label: o.label })),
        onClick: ({ key }) => setMode(key as ThemeMode),
      }}
    >
      <Tooltip title={`Theme: ${OPTIONS.find((o) => o.key === mode)?.label}`}>
        <Button type="text" icon={icon} aria-label="Change theme" />
      </Tooltip>
    </Dropdown>
  );
}
