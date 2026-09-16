// DeliveryNotice — the one place the delivery-vs-completion caveat lives.
//
// Every surface in the broker module that shows a throughput rate (in/s,
// out/s, consumer rate, ...) reads as "business is fine" to a tired
// operator. It isn't necessarily: these numbers come from Pulsar's own
// stats, which count messages handed to a consumer connection, not
// messages a consumer finished acting on. That distinction isn't visible
// until a later phase (WritePermit-gated consumer-side evidence), so until
// then every rate needs this notice next to it — in exactly one component,
// so the wording is never forked across panels.
//
// `variant="inline"` sits beside a number with no heading; `variant="block"`
// stands alone as its own paragraph. Both render `role="note"` with the
// same sentence — this is a caveat on data already on screen, not an alert
// about something wrong, so it is not `role="alert"` or `role="status"`.
export interface DeliveryNoticeProps {
  variant: "inline" | "block";
}

const NOTICE_TEXT =
  "These rates count messages delivered to a consumer. Whether the consumer processed them is not visible here.";

export function DeliveryNotice({ variant }: DeliveryNoticeProps) {
  if (variant === "inline") {
    return (
      <span role="note" className="text-xs text-muted-foreground">
        {NOTICE_TEXT}
      </span>
    );
  }

  return (
    <p role="note" className="text-sm text-muted-foreground">
      {NOTICE_TEXT}
    </p>
  );
}
