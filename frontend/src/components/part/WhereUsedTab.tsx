import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { App as AntdApp, Empty, Space, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type { WhereUsedEntry } from '../../api/types';
import { LifecycleTag } from '../meta';

/*
 * A consumer the caller may not see is a ROW with no identity, not an omission (rule X4): an
 * empty list would invite breaking a programme they cannot see.
 *
 * The server has already replaced the part number and name with the 'Restricted' sentinel from
 * `lib/acl.ts` — but it still sends the real `id`, so rendering this row the way the others are
 * rendered produced a link to `/parts/<real id>` that the caller cannot open: a dead click, and
 * the id of a restricted part in their URL bar and in the DOM. A tag instead, and the sentinel
 * is what distinguishes the two cases.
 *
 * The comparison is to a string literal, which is an agreement with the server that nothing
 * type-checks. `tests/where-used.test.ts` reads this file and asserts the literal matches
 * `REDACTED.partNumber`, so changing one without the other fails rather than silently going
 * back to rendering dead links.
 */
function assemblyCell(
  parentPart: { id: number; partNumber: string },
  parentRevision: { id: number }
): JSX.Element {
  if (parentPart.partNumber === 'Restricted') {
    return (
      <Tooltip title="Something uses this part, but you do not have access to the assembly.">
        <Tag>Restricted</Tag>
      </Tooltip>
    );
  }
  return (
    <Link to={`/parts/${parentPart.id}?rev=${parentRevision.id}`}>{parentPart.partNumber}</Link>
  );
}

export default function WhereUsedTab({ partId }: { partId: number }): JSX.Element {
  const { message } = AntdApp.useApp();
  const [entries, setEntries] = useState<WhereUsedEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await api.getWhereUsed(partId));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [partId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<WhereUsedEntry> = [
    {
      title: 'Parent Part Number',
      key: 'parentPartNumber',
      render: (_, entry) => assemblyCell(entry.parentPart, entry.parentRevision),
    },
    {
      title: 'Parent Name',
      key: 'parentName',
      render: (_, entry) => entry.parentPart.name,
    },
    {
      title: 'Parent Rev',
      key: 'parentRev',
      render: (_, entry) => (
        <Space size={4}>
          <Tag>{entry.parentRevision.revision}</Tag>
          <LifecycleTag lifecycle={entry.parentRevision.lifecycle} />
        </Space>
      ),
    },
    {
      title: 'Find #',
      key: 'findNumber',
      width: 90,
      render: (_, entry) => entry.line.findNumber,
    },
    {
      title: 'Qty',
      key: 'quantity',
      width: 90,
      align: 'right',
      render: (_, entry) => entry.line.quantity,
    },
    {
      title: 'UoM',
      key: 'uom',
      width: 80,
      render: (_, entry) => entry.line.uom,
    },
  ];

  return (
    <Table<WhereUsedEntry>
      size="middle"
      rowKey={(entry) => entry.line.id}
      columns={columns}
      dataSource={entries}
      loading={loading}
      pagination={false}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="This part is not used in any BOM."
          />
        ),
      }}
    />
  );
}
