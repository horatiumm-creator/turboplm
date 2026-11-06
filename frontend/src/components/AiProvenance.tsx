import { Space, Tag, Tooltip } from 'antd';
import type { AiPaidBy } from '../api/types';

/**
 * Where an AI answer came from, and whose money paid for it.
 *
 * One component for all three AI features, because the three were drifting: two of them
 * labelled the model and one did not, and none of them said who was billed. A reader of an
 * AI-written summary is entitled to know what wrote it and that it is advisory; the person
 * pressing the button is entitled to know whose provider account just spent money.
 *
 * `paidBy` matters more than it looks. The same button charges the deployment's key for one
 * person and the engineer's own key for another, and the only way to tell is to be told.
 *
 * It is nullable, and a null omits that tag rather than guessing one. Naming the wrong payer
 * would be worse than naming none: somebody would go looking for the spend in an account that
 * never saw it. The model and the advisory label are never omitted.
 */
export default function AiProvenance({
  model,
  paidBy,
}: {
  model: string | null;
  paidBy: AiPaidBy | null;
}): JSX.Element {
  return (
    <Space size={6} wrap>
      {model && <Tag>{model}</Tag>}
      <Tag color="default">advisory</Tag>
      {paidBy && (
        <Tooltip
          title={
            paidBy === 'user'
              ? 'Billed to your own provider account, using the key in your profile'
              : "Billed to this deployment's provider account, configured by an administrator"
          }
        >
          <Tag color={paidBy === 'user' ? 'blue' : 'default'}>
            {paidBy === 'user' ? 'your key' : 'deployment key'}
          </Tag>
        </Tooltip>
      )}
    </Space>
  );
}
