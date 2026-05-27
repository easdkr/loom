import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { splitProjectScopedId } from "@core/index";
import { Badge, Button, Field, IconButton, Textarea } from "@design/components";
import { getExecutionStore, useExecutionStore, useWorkspaceStore } from "@stores/index";

interface HumanReviewUpstream {
  node_id: string;
  result: string;
}

interface HumanReviewRequest {
  run_id: string;
  node_id: string;
  prompt: string;
  upstream: HumanReviewUpstream[];
}

function HumanReviewModal() {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const request = useExecutionStore((state) => state.pendingHumanReview);
  const open = useExecutionStore((state) => state.humanReviewOpen);
  const setPendingHumanReview = useExecutionStore((state) => state.setPendingHumanReview);
  const setHumanReviewOpen = useExecutionStore((state) => state.setHumanReviewOpen);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    listen<HumanReviewRequest>("graph:human-review-required", (event) => {
      const { projectId, localId } = splitProjectScopedId(event.payload.node_id);
      const targetProjectId = projectId || activeWorkspaceId;
      if (!targetProjectId) {
        return;
      }
      getExecutionStore(targetProjectId).getState().setPendingHumanReview({
        nodeId: localId,
        fullNodeId: event.payload.node_id,
        prompt: event.payload.prompt,
        upstream: event.payload.upstream,
        requestedAt: Date.now(),
      });
      setNote("");
      setReason("");
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [activeWorkspaceId]);

  if (!request || !open) {
    return null;
  }

  async function approve() {
    if (!request) return;
    setSubmitting(true);
    try {
      await invoke("node_approve", {
        request: { node_id: request.fullNodeId, note: note.trim() || null },
      });
      setPendingHumanReview(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function reject() {
    if (!request) return;
    setSubmitting(true);
    try {
      await invoke("node_reject", {
        request: {
          node_id: request.fullNodeId,
          reason: reason.trim() || "rejected by reviewer",
        },
      });
      setPendingHumanReview(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="plan-review-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Human Review"
    >
      <div className="plan-review-sheet plan-review-sheet--human">
        <header className="plan-review-header">
          <span className="plan-review-title">사람 검토 대기 — {request.nodeId}</span>
          <Badge tone="warning">paused</Badge>
          <IconButton aria-label="Defer" onClick={() => setHumanReviewOpen(false)}>
            ✕
          </IconButton>
        </header>

        <div className="plan-review-list">
          <Field label="이전 노드 출력">
            {request.upstream.length === 0 ? (
              <p className="plan-inspector-empty">상위 노드 출력이 없습니다.</p>
            ) : (
              <ol className="plan-review-list">
                {request.upstream.map((entry) => (
                  <li key={entry.node_id} className="plan-review-item">
                    <header className="plan-review-item-head">
                      <Badge tone="neutral">{entry.node_id}</Badge>
                    </header>
                    <pre className="auto-node-prompt">{entry.result || "(empty)"}</pre>
                  </li>
                ))}
              </ol>
            )}
          </Field>

          <Field label="검토 프롬프트">
            <pre className="auto-node-prompt">{request.prompt}</pre>
          </Field>

          <Field label="승인 메모 (선택)">
            <Textarea
              value={note}
              rows={3}
              onChange={(event) => setNote(event.target.value)}
              placeholder="후속 노드에 전달할 메모"
            />
          </Field>

          <Field label="거부 사유 (선택)">
            <Textarea
              value={reason}
              rows={2}
              onChange={(event) => setReason(event.target.value)}
              placeholder="실행을 중단할 이유"
            />
          </Field>
        </div>

        <footer className="plan-review-footer">
          <Button variant="danger" disabled={submitting} onClick={reject}>
            Reject
          </Button>
          <Button variant="primary" disabled={submitting} onClick={approve}>
            Approve & Continue
          </Button>
        </footer>
      </div>
    </div>
  );
}

export default HumanReviewModal;
