import { Link, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { CloudGate } from "@/components/cloud/CloudGate";
import { cloudEnabled } from "@/lib/cloud/config";
import { EmptyState } from "@/components/ui";
import { AiInboxPage, ProposalReviewPage } from "@/pages/AiPages";
import { AnalysisPage } from "@/pages/AnalysisPage";
import { AskPage } from "@/pages/AskPage";
import { AuditPage } from "@/pages/AuditPage";
import { ChecksPage } from "@/pages/ChecksPage";
import { DecisionsPage } from "@/pages/DecisionsPage";
import { DocumentPage } from "@/pages/DocumentPage";
import { DiagramEditorPage } from "@/pages/DiagramEditorPage";
import { DiagramsPage } from "@/pages/DiagramsPage";
import { EmbedPage } from "@/pages/EmbedPage";
import { HealthPage } from "@/pages/HealthPage";
import { ModelPage } from "@/pages/ModelPage";
import { PresentPage } from "@/pages/PresentPage";
import { ReviewPage, ReviewsPage } from "@/pages/ReviewsPages";
import { RulesPage } from "@/pages/RulesPage";
import { ScenariosPage } from "@/pages/ScenariosPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SharedViewPage } from "@/pages/SharedViewPage";
import { TrustPage } from "@/pages/TrustPage";
import { VersionPage, VersionsPage } from "@/pages/VersionsPages";

function NotFound() {
  return (
    <EmptyState title="This page does not exist" text="The address may be mistyped, or the diagram may have been deleted.">
      <Link to="/" className="font-medium text-blueprint hover:underline">
        Go to diagrams
      </Link>
    </EmptyState>
  );
}

export default function App() {
  const app = (
    <AppShell>
      <Routes>
        <Route path="/" element={<DiagramsPage />} />
        <Route path="/diagram/:id" element={<DiagramEditorPage />} />
        <Route path="/model" element={<ModelPage />} />
        <Route path="/analysis" element={<AnalysisPage />} />
        <Route path="/ask" element={<AskPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/checks" element={<ChecksPage />} />
        <Route path="/checks/rules" element={<RulesPage />} />
        <Route path="/document" element={<DocumentPage />} />
        <Route path="/decisions" element={<DecisionsPage />} />
        <Route path="/decisions/:id" element={<DecisionsPage />} />
        <Route path="/ai" element={<AiInboxPage />} />
        <Route path="/ai/:id" element={<ProposalReviewPage />} />
        {cloudEnabled && (
          <>
            <Route path="/versions" element={<VersionsPage />} />
            <Route path="/versions/:id" element={<VersionPage />} />
            <Route path="/reviews" element={<ReviewsPage />} />
            <Route path="/reviews/:id" element={<ReviewPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/scenarios" element={<ScenariosPage />} />
          </>
        )}
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
  );
  return (
    <Routes>
      {/* Shared links open without the application around them, and without signing in. */}
      <Route path="/share" element={<SharedViewPage />} />
      {/* A live link shows one diagram from the hosted backend, also without signing in. */}
      {cloudEnabled && <Route path="/embed/:token" element={<EmbedPage />} />}
      {/* The public trust page: where personal data is kept and who receives it. No sign-in. */}
      {cloudEnabled && <Route path="/trust/:token" element={<TrustPage />} />}
      {/* With a hosted backend, everything else waits for sign-in and an open workspace. */}
      {/* Presenting shows one diagram with nothing around it; it still needs the workspace, so it waits for sign-in too. */}
      <Route path="/present/:id" element={cloudEnabled ? <CloudGate><PresentPage /></CloudGate> : <PresentPage />} />
      <Route path="*" element={cloudEnabled ? <CloudGate>{app}</CloudGate> : app} />
    </Routes>
  );
}
