import Image from "next/image";
import { CheckCircle2, XCircle } from "lucide-react";
import { handleEmailResponse } from "@/lib/agent";
import { formatINR } from "@/lib/format";

interface ConfirmPageProps {
  searchParams: Promise<{ t?: string; r?: string; token?: string }>;
}

const VALID_RESPONSES = ["paid", "not_paid", "paid_elsewhere"] as const;
type ValidResponse = (typeof VALID_RESPONSES)[number];

function isValidResponse(value: string | undefined): value is ValidResponse {
  return VALID_RESPONSES.includes(value as ValidResponse);
}

export default async function ConfirmPage({ searchParams }: ConfirmPageProps) {
  const { t: transactionId, r: response, token } = await searchParams;

  let result: { ok: boolean; message: string; amount?: number } | null = null;

  if (!transactionId || !token || !isValidResponse(response)) {
    result = { ok: false, message: "This link is missing required information." };
  } else {
    const outcome = await handleEmailResponse(transactionId, token, response);
    result = {
      ok: outcome.ok,
      message: outcome.message,
      amount: outcome.transaction?.amount,
    };
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mb-6 flex justify-center">
          <div className="rounded-md bg-white p-1.5">
            <Image src="/razorpay-logo.svg" alt="Razorpay" width={104} height={22} />
          </div>
        </div>

        {result.ok ? (
          <CheckCircle2 className="mx-auto mb-3 size-10 text-success" />
        ) : (
          <XCircle className="mx-auto mb-3 size-10 text-destructive" />
        )}

        <p className="text-sm text-foreground">{result.message}</p>
        {result.ok && result.amount !== undefined && (
          <p className="mt-2 text-xs text-muted-foreground">
            Transaction amount: {formatINR(result.amount)}
          </p>
        )}
      </div>
    </div>
  );
}
