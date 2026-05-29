import { createFileRoute } from "@tanstack/react-router";
import ZapplyEmbed from "@/components/ZapplyEmbed";

export const Route = createFileRoute("/finance-assistant")({
  head: () => ({ meta: [{ title: "Finance Assistant" }] }),
  component: FinanceAssistantPage,
});

function FinanceAssistantPage() {
  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-semibold text-foreground">
          Finance Assistant
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Ask questions about your finances. The chat widget is available in
          the bottom-right corner.
        </p>
      </div>
      <ZapplyEmbed />
    </div>
  );
}
