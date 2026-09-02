import { NextResponse } from "next/server";
import { buildCustomerRecoveryProfiles, customerIdentityKey } from "@/lib/customer-recovery";
import { readCustomerHistoryTransactions } from "@/lib/customer-history-store";
import { readTransactions } from "@/lib/transactions-store";

// One customer's full profile plus every transaction of theirs, newest
// first - the data backing the customer detail page (app/customers/[customerId]).
// customerId is customerIdentityKey's own composite key (lib/customer-recovery.ts),
// URL-encoded by the caller since it can contain spaces/@/:: .
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ customerId: string }> }
) {
  const { customerId: rawId } = await params;
  const customerId = decodeURIComponent(rawId);

  try {
    const [transactions, history] = await Promise.all([
      readTransactions(),
      readCustomerHistoryTransactions(),
    ]);
    const allTransactions = [...history, ...transactions];
    const customer = buildCustomerRecoveryProfiles(allTransactions).find(
      (c) => c.customerId === customerId
    );
    if (!customer) {
      return NextResponse.json({ error: "Customer not found." }, { status: 404 });
    }

    const customerTransactions = allTransactions
      .filter((t) => customerIdentityKey(t) === customerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return NextResponse.json({ customer, transactions: customerTransactions });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to load customer: ${error.message}`
            : "Failed to load customer.",
      },
      { status: 500 }
    );
  }
}
