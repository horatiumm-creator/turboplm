import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { App as AntdApp, Empty, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type { PartDetail, RequirementSummary } from '../../api/types';
import { ReqStatusTag, ReqTypeTag } from '../meta';

export default function RequirementsTab({ part }: { part: PartDetail }): JSX.Element {
  const { message } = AntdApp.useApp();
  const [requirements, setRequirements] = useState<RequirementSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRequirements(await api.getPartRequirements(part.id));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [part.id, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<RequirementSummary> = [
    {
      title: 'REQ #',
      key: 'reqNumber',
      width: 140,
      render: (_, req) => <Link to={`/requirements/${req.id}`}>{req.reqNumber}</Link>,
    },
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
    },
    {
      title: 'Type',
      key: 'type',
      width: 130,
      render: (_, req) => <ReqTypeTag type={req.type} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, req) => <ReqStatusTag status={req.status} />,
    },
  ];

  return (
    <Table<RequirementSummary>
      size="middle"
      rowKey="id"
      columns={columns}
      dataSource={requirements}
      loading={loading}
      pagination={false}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No requirements are satisfied by this part."
          />
        ),
      }}
    />
  );
}
