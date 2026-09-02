import { NextResponse } from "next/server";
import { readCustomerHistoryTransactions } from "@/lib/customer-history-store";
import { isOrderPaid } from "@/lib/payment-attempts";
import type { Transaction } from "@/lib/types";

// "Previous Records" for the dashboard - permanent, already-resolved
// customer history (lib/customer-history-store.ts), distinct from the
// CURRENT at-risk batch in data/transactions.json. Summary figures here are
// scoped to this history only, never mixed with the live/current numbers.

const PAYMENT_LINK_ACTIONS = new Set(["generated_payment_link", "resent_payment_link"]);
const REMINDER_ACTIONS = new Set(["sent_email_reminder", "sent_reminder", "sent_sms_reminder", "sent_whatsapp_reminder"]);

function resolvedAt(transaction: Transaction): string | null {
  const paidAttempt = transaction.attempts.find((a) => a.outcome === "paid");
  return paidAttempt?.respondedAt ?? paidAttempt?.timestamp ?? null;
}

function recoveryChannel(transaction: Transaction): "payment_link" | "reminder" | "other" {
  const paidAttempt = transaction.attempts.find((a) => a.outcome === "paid");
  if (!paidAttempt) return "other";
  if (PAYMENT_LINK_ACTIONS.has(paidAttempt.actionTaken)) return "payment_link";
  if (REMINDER_ACTIONS.has(paidAttempt.actionTaken)) return "reminder";
  return "other";
}

export async function GET() {
  try {
    const transactions = (await readCustomerHistoryTransactions()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );

    const totalAtRisk = transactions.reduce((sum, t) => sum + t.amount, 0);
    const recovered = transactions.filter((t) => isOrderPaid(t));
    const totalRecovered = recovered.reduce((sum, t) => sum + t.amount, 0);
    const remaining = totalAtRisk - totalRecovered;
    const recoveryRate = totalAtRisk > 0 ? (totalRecovered / totalAtRisk) * 100 : 0;

    const avgAttempts =
      transactions.length > 0
        ? transactions.reduce((sum, t) => sum + t.attempts.length, 0) / transactions.length
        : 0;

    const delaysHours = recovered
      .map((t) => {
        const at = resolvedAt(t);
        if (!at) return null;
        const hours = (new Date(at).getTime() - new Date(t.createdAt).getTime()) / 3600_000;
        return hours >= 0 ? hours : null;
      })
      .filter((v): v is number => v !== null);
    const avgDelayHours = delaysHours.length > 0 ? delaysHours.reduce((s, v) => s + v, 0) / delaysHours.length : null;

    const channelCounts = { payment_link: 0, reminder: 0, other: 0 };
    for (const t of recovered) channelCounts[recoveryChannel(t)] += 1;
    const unrecoveredCount = transactions.length - recovered.length;

    return NextResponse.json({
      transactions,
      summary: {
        totalAtRisk,
        totalRecovered,
        remaining,
        recoveryRate: Math.round(recoveryRate * 10) / 10,
        casesProcessed: transactions.length,
        recoveredCount: recovered.length,
        unrecoveredCount,
        avgAttempts: Math.round(avgAttempts * 10) / 10,
        avgDelayHours: avgDelayHours !== null ? Math.round(avgDelayHours * 10) / 10 : null,
        byChannel: [
          { key: "payment_link", label: "Payment Link", count: channelCounts.payment_link },
          { key: "reminder", label: "Reminder", count: channelCounts.reminder },
          { key: "unrecovered", label: "Unrecovered", count: unrecoveredCount },
        ],
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to load customer history: ${error.message}`
            : "Failed to load customer history.",
      },
      { status: 500 }
    );
  }
}
