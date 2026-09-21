"use client";

import { useRouter } from "next/navigation";
import { DeleteButton } from "@/components/delete-button";
import { deleteClient } from "@/lib/actions";

export function DeleteClientButton({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const router = useRouter();
  return (
    <DeleteButton
      onDelete={() => deleteClient(clientId)}
      confirmMessage={`Delete ${clientName}? This can't be undone.`}
      label="Delete Client"
      className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink hover:border-overdue hover:text-overdue disabled:opacity-50"
      onSuccess={() => router.push("/clients")}
    />
  );
}
