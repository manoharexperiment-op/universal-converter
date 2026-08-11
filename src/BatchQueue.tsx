import { useEffect, useState } from 'react';
import type { BatchQueue as Queue, QueueItem, QueueSnapshot } from './converters/batchQueue';

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(1))} ${units[i]}`;
}

const LABEL: Record<QueueItem['status'], string> = {
  queued: 'Waiting',
  running: 'Working',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
};

function Row({ item, onRetry, onSave }: { item: QueueItem; onRetry: () => void; onSave: () => void }) {
  const [showDetail, setShowDetail] = useState(false);
  return (
    <div className={`bq-row bq-${item.status}`}>
      <div className="bq-main">
        <span className="bq-name" title={item.file.name}>{item.file.name}</span>
        <span className="bq-meta">
          {formatSize(item.file.size)}
          {item.ms !== undefined && item.status === 'done' ? ` · ${(item.ms / 1000).toFixed(1)}s` : ''}
        </span>
      </div>

      {item.status === 'running' && (
        <div className="bq-bar">
          <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
        </div>
      )}

      <div className="bq-side">
        <span className={`bq-status bq-status-${item.status}`}>{LABEL[item.status]}</span>
        {item.status === 'done' && (
          <button type="button" onClick={onSave} title="Save this one">⬇</button>
        )}
        {(item.status === 'failed' || item.status === 'cancelled') && (
          <button type="button" onClick={onRetry} title="Try this file again">↻</button>
        )}
      </div>

      {item.error && (
        <p className="bq-error">
          {item.error}
          {item.detail && (
            <button type="button" className="bq-detail-toggle" onClick={() => setShowDetail((v) => !v)}>
              {showDetail ? 'Hide details' : 'Details'}
            </button>
          )}
        </p>
      )}
      {showDetail && item.detail && <pre className="bq-detail">{item.detail}</pre>}
    </div>
  );
}

export function BatchQueuePanel({
  queue,
  onSaveOne,
  onSaveAll,
}: {
  queue: Queue;
  onSaveOne: (item: QueueItem) => void;
  onSaveAll: () => void;
}) {
  const [snap, setSnap] = useState<QueueSnapshot>(() => queue.snapshot());
  useEffect(() => queue.subscribe(setSnap), [queue]);

  const { items, running, overall, doneCount, failedCount } = snap;
  const settled = items.filter((i) => i.status !== 'queued' && i.status !== 'running').length;
  const retryable = items.some((i) => i.status === 'failed' || i.status === 'cancelled');

  return (
    <div className="bq">
      <div className="bq-head">
        <strong>
          {running ? `Working through ${items.length} files` : `${settled} of ${items.length} finished`}
        </strong>
        <span className="bq-counts">
          {doneCount > 0 && <span className="bq-ok">{doneCount} done</span>}
          {failedCount > 0 && <span className="bq-bad">{failedCount} failed</span>}
        </span>
      </div>

      <div className="bq-overall">
        <span style={{ width: `${Math.round(overall * 100)}%` }} />
      </div>

      <div className="bq-controls">
        {running && (
          <>
            <button type="button" onClick={() => void queue.skip()}>Skip this file</button>
            <button type="button" className="bq-stop" onClick={() => void queue.cancelAll()}>Stop everything</button>
          </>
        )}
        {!running && retryable && (
          <button type="button" onClick={() => queue.retryAllFailed()}>Try the failed ones again</button>
        )}
        {doneCount > 0 && (
          <button type="button" className="bq-save" onClick={onSaveAll}>
            Save all {doneCount} as a zip
          </button>
        )}
      </div>

      <div className="bq-list">
        {items.map((it) => (
          <Row key={it.id} item={it} onRetry={() => queue.retry(it.id)} onSave={() => onSaveOne(it)} />
        ))}
      </div>
    </div>
  );
}
