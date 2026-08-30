// Real transactional email via Brevo (formerly Sendinblue), used only for
// transactions that have a real customerEmail set. Everything else in the app
// keeps simulating messages — this is the one path that sends something a real
// person actually receives.

interface SendConfirmationEmailInput {
  toEmail: string;
  toName: string;
  transactionId: string;
  amount: number;
  message: string; // the AI's customer-facing message for this attempt
  paidUrl: string;
  notPaidUrl: string;
  paidElsewhereUrl: string;
}

function getBrevoConfig(): { apiKey: string; senderEmail: string } {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey) {
    throw new Error(
      "BREVO_API_KEY is not set. Add it to .env.local (see .env.local.example)."
    );
  }
  if (!senderEmail) {
    throw new Error(
      "BREVO_SENDER_EMAIL is not set. Add it to .env.local — must be a sender verified in your Brevo account."
    );
  }
  return { apiKey, senderEmail };
}

function buildEmailHtml(input: SendConfirmationEmailInput): string {
  const amountLabel = `₹${input.amount.toLocaleString("en-IN")}`;
  return `
<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #0F172A;">
  <div style="background: #0C2451; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <span style="color: #ffffff; font-weight: 700; font-size: 16px;">Razorpay</span>
    <span style="color: rgba(255,255,255,0.7); font-size: 14px; margin-left: 8px;">Revenue Recovery Agent</span>
  </div>
  <div style="border: 1px solid #E5E7EB; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
    <p style="font-size: 15px; line-height: 1.6; margin: 0 0 16px;">${input.message}</p>
    <p style="font-size: 13px; color: #64748B; margin: 0 0 20px;">
      Transaction ${input.transactionId} &middot; ${amountLabel}
    </p>
    <p style="font-size: 14px; font-weight: 600; margin: 0 0 12px;">Has this payment been completed?</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
      <tr>
        <td style="padding-bottom: 10px;">
          <a href="${input.paidUrl}" style="display: block; text-align: center; background: #16A34A; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px; border-radius: 6px;">
            Yes, I've paid
          </a>
        </td>
      </tr>
      <tr>
        <td style="padding-bottom: 10px;">
          <a href="${input.notPaidUrl}" style="display: block; text-align: center; background: #DC2626; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px; border-radius: 6px;">
            No, not yet
          </a>
        </td>
      </tr>
      <tr>
        <td>
          <a href="${input.paidElsewhereUrl}" style="display: block; text-align: center; background: #F1F5F9; color: #0F172A; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px; border-radius: 6px; border: 1px solid #E5E7EB;">
            I paid another way (cash / other method)
          </a>
        </td>
      </tr>
    </table>
  </div>
</div>`.trim();
}

export async function sendConfirmationEmail(
  input: SendConfirmationEmailInput
): Promise<void> {
  const { apiKey, senderEmail } = getBrevoConfig();

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      sender: { name: "Revenue Recovery Agent", email: senderEmail },
      to: [{ email: input.toEmail, name: input.toName }],
      subject: `Action needed: your payment of ₹${input.amount.toLocaleString("en-IN")}`,
      htmlContent: buildEmailHtml(input),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Brevo API error (${res.status}): ${body.slice(0, 300)}`);
  }
}
