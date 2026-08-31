import { NextResponse } from "next/server";
import { buildCustomerRecoveryProfiles, customerIdentityKey } from "@/lib/customer-recovery";
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
    const transactions = await readTransactions();
    const customer = buildCustomerRecoveryProfiles(transactions).find(
      (c) => c.customerId === customerId
    );
    if (!customer) {
      return NextResponse.json({ error: "Customer not found." }, { status: 404 });
    }

    const customerTransactions = transactions
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
