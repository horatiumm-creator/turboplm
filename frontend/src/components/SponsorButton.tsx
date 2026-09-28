import { useState } from 'react';
import { Button, Divider, Modal, Typography } from 'antd';
import { ExportOutlined, HeartOutlined, ReloadOutlined } from '@ant-design/icons';

/**
 * Sponsorship, in the open-source build only.
 *
 * This component exists in this repository and NOT in the hosted SaaS, and that separation is
 * the point: asking a paying customer to sponsor the thing they already pay for reads as a
 * second invoice. Here, where the whole product is AGPL and free to run, it is the only thing
 * that funds the work.
 *
 * `frequency` is a real GitHub Sponsors parameter — the page serves both `one-time` and
 * `recurring` checkout flows — so the two buttons land the sponsor on the right one instead
 * of on a generic page they then have to navigate.
 */
const SPONSORS_URL = 'https://github.com/sponsors/horatiumm-creator';

export function SponsorButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="text"
        icon={<HeartOutlined />}
        onClick={() => setOpen(true)}
        /*
          No aria-label. The button already has a visible label, and an aria-label REPLACES it
          for assistive tech — so "Sponsor" on screen would have been announced, and matched by
          voice control, as something else entirely.
        */
      >
        Sponsor
      </Button>

      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={[
          <Button key="close" type="link" onClick={() => setOpen(false)}>
            CLOSE
          </Button>,
        ]}
        width={640}
        title={
          <span>
            <HeartOutlined style={{ color: '#eb2f96', marginRight: 10 }} />
            Support TurboPLM
          </span>
        }
      >
        <Typography.Title level={5} style={{ marginTop: 8 }}>
          Why sponsorship
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          TurboPLM is free, AGPL and self-hosted — there is no licence to sell. Running it has
          real costs all the same: the public demo and its database, and above all the time
          that goes into security patches, upgrades and answering issues. Sponsorship is what
          pays for that.
        </Typography.Paragraph>

        <blockquote
          style={{
            borderLeft: '4px solid #722ed1',
            margin: '20px 0',
            padding: '4px 0 4px 16px',
            fontStyle: 'italic',
          }}
        >
          <Typography.Text>
            A small hardware team should not have to choose between a spreadsheet and a
            six-figure PLM. The part master, the bill of materials and change control are the
            record a company runs on — they deserve to be owned by the people who create them,
            on their own hardware, in a system they can read.
          </Typography.Text>
        </blockquote>

        <Divider />

        <Typography.Title level={5}>How to sponsor</Typography.Title>
        <Typography.Paragraph type="secondary">
          Via GitHub Sponsors. Choose a one-time gift or a regular monthly contribution:
        </Typography.Paragraph>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Button
            type="primary"
            size="large"
            icon={<HeartOutlined />}
            href={`${SPONSORS_URL}?frequency=one-time`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ background: 'linear-gradient(90deg,#722ed1,#eb2f96)', border: 'none' }}
          >
            ONE-TIME
          </Button>
          <Button
            type="primary"
            size="large"
            icon={<ReloadOutlined />}
            href={`${SPONSORS_URL}?frequency=recurring`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ background: 'linear-gradient(90deg,#722ed1,#eb2f96)', border: 'none' }}
          >
            MONTHLY
          </Button>
        </div>
        <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }}>
          <a href={SPONSORS_URL} target="_blank" rel="noopener noreferrer">
            <ExportOutlined style={{ marginRight: 6 }} />
            Open the sponsors page
          </a>
        </Typography.Paragraph>
      </Modal>
    </>
  );
}
