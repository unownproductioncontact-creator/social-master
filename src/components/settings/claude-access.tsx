"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { revokeClaudeAccess } from "@/lib/actions/mcp-oauth";

export type ClaudeGrant = { id: string; clientName: string; createdAt: string; lastUsedAt: string | null };

/** Accès accordés au connecteur Claude (MCP, CLAUDE.md §29) avec révocation immédiate. */
export function ClaudeAccess({ grants, connectorUrl }: { grants: ClaudeGrant[]; connectorUrl: string }) {
  const [isPending, startTransition] = useTransition();

  function revoke(id: string) {
    startTransition(async () => {
      const result = await revokeClaudeAccess(id);
      if (result.error) toast.error(result.error);
      else toast.success("Accès révoqué.");
    });
  }

  return (
    <div className="space-y-3 text-[12.5px]">
      <p className="text-muted-foreground">
        Pour piloter Social Master depuis vos conversations Claude : Claude → Réglages → Connecteurs → « Ajouter un
        connecteur personnalisé », avec l&apos;adresse :
      </p>
      <code className="block break-all rounded-md border border-border bg-muted px-2 py-1.5 text-[12px]">{connectorUrl}</code>
      {grants.length === 0 ? (
        <p className="text-muted-foreground">Aucun accès accordé pour l&apos;instant.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-semibold text-foreground">{g.clientName}</p>
                <p className="text-muted-foreground">
                  Autorisé le {g.createdAt}
                  {g.lastUsedAt ? ` · dernière utilisation ${g.lastUsedAt}` : ""}
                </p>
              </div>
              <Button size="sm" variant="outline" disabled={isPending} onClick={() => revoke(g.id)}>
                Révoquer
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
