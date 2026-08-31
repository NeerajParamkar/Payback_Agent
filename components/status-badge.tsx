import { Badge } from "@/components/ui/badge";
import { humanize } from "@/lib/format";
import type { TransactionStatus } from "@/lib/types";

const STATUS_STYLES: Record<TransactionStatus, string> = {
  recovered: "border-success/30 bg-success/15 text-success",
  unrecovered: "border-destructive/30 bg-destructive/15 text-destructive",
  in_progress: "border-warning/30 bg-warning/15 text-warning",
  pending: "border-border bg-muted text-muted-foreground",
  waiting_for_response: "border-brand-blue/30 bg-brand-blue/15 text-brand-blue",
  awaiting_payment: "border-brand-blue/30 bg-brand-blue/15 text-brand-blue",
  escalated: "border-destructive/30 bg-destructive/15 text-destructive",
  promise_to_pay: "border-warning/30 bg-warning/15 text-warning",
};

export function StatusBadge({ status }: { status: TransactionStatus }) {
  return (
    <Badge variant="outline" className={STATUS_STYLES[status]}>
      {humanize(status)}
    </Badge>
  );
}
