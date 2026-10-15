export interface Proposal {
  id: string;
  title: string;
  status: "draft" | "sent" | "accepted";
}

export async function listProposals(): Promise<Proposal[]> {
  const rows = await query("select id, title, status from proposals order by created_at desc");
  return rows as Proposal[];
}

export async function query(_sql: string): Promise<unknown[]> {
  return [];
}

export function formatTitle(title: string): string {
  return title.trim();
}
