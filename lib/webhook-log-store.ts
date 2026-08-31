import { promises as fs } from "fs";
import path from "path";
import type { WebhookLogEntry } from "@/lib/types";

const DATA_FILE = path.join(process.cwd(), "data", "webhook-events.json");

export async function readWebhookLog(): Promise<WebhookLogEntry[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw) as WebhookLogEntry[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeWebhookLog(entries: WebhookLogEntry[]): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(entries, null, 2) + "\n", "utf-8");
}

export async function hasProcessedEventKey(eventKey: string): Promise<boolean> {
  const entries = await readWebhookLog();
  return entries.some((e) => e.eventKey === eventKey && e.status === "processed");
}

export async function appendWebhookLogEntry(
  entry: Omit<WebhookLogEntry, "id" | "receivedAt">
): Promise<void> {
  const entries = await readWebhookLog();
  entries.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: new Date().toISOString(),
    ...entry,
  });
  await writeWebhookLog(entries);
}

export async function resetWebhookLog(): Promise<void> {
  await writeWebhookLog([]);
}
