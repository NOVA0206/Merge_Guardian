"use client";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import type { Proposal } from "@/lib/db";

export function ProposalList() {
  const [items, setItems] = useState<Proposal[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    fetch("/api/proposals")
      .then((r) => r.json())
      .then((data) => {
        setItems(data.proposals);
        setTotal(data.total);
      });
  }, []);

  return (
    <ul aria-label={`${total} proposals`}>
      {items.map((p) => (
        <li key={p.id}>
          {p.title} <Badge label={p.status} />
        </li>
      ))}
    </ul>
  );
}
