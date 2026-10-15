export async function getSession(): Promise<{ user: string } | null> {
  return { user: "demo" };
}
