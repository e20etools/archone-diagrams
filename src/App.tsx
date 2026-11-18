import { lazy, Suspense, type ReactNode } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { CloudGate } from "@/components/cloud/CloudGate";
import { cloudEnabled } from "@/lib/cloud/config";
import { EmptyState } from "@/components/ui";
import { AiInboxPage, ProposalReviewPage } from "@/pages/AiPages";
import { ImpactPage } from "./pages/ImpactPage";
import { MapPage } from "./pages/MapPage";
import { FilesPage } from "./pages/FilesPage";
import { ReportsPage } from "./pages/ReportsPage";
import { AnalysisPage } from "@/pages/AnalysisPage";
import { AskPage } from "@/pages/AskPage";
import { AuditPage } from "@/pages/AuditPage";
import { ChecksPage } from "@/pages/ChecksPage";
import { DecisionsPage } from "@/pages/DecisionsPage";
import { DocumentPage } from "@/pages/DocumentPage";
import { DiagramEditorPage } from "@/pages/DiagramEditorPage";
import { DiagramsPage } from "@/pages/DiagramsPage";
import { HomePage } from "@/pages/HomePage";
import { ComponentTreePage } from "@/pages/ComponentTreePage";
import { EmbedPage } from "@/pages/EmbedPage";
import { HealthPage } from "@/pages/HealthPage";
import { ModelPage } from "@/pages/ModelPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { PresentPage } from "@/pages/PresentPage";
import { ReviewPage, ReviewsPage } from "@/pages/ReviewsPages";
import { ApprovalsPage } from "@/pages/ApprovalsPage";
import { VerifyPage } from "@/pages/VerifyPage";
import { RulesPage } from "@/pages/RulesPage";
import { ScenariosPage } from "@/pages/ScenariosPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SharedViewPage } from "@/pages/SharedViewPage";
import { TrustPage } from "@/pages/TrustPage";
import { VersionPage, VersionsPage } from "@/pages/VersionsPages";

// The process pages carry the BPMN modeler, so they load only when opened.
const ProcessesPage = lazy(() => import("@/pages/processes/ProcessesPage"));
const ProcessPage = lazy(() => import("@/pages/processes/ProcessPage"));
const MiningPage = lazy(() => import("@/pages/processes/MiningPage"));
const BpmnLibraryPage = lazy(() => import("@/pages/processes/BpmnLibraryPage"));
const later = (page: ReactNode) => <Suspense fallback={<p className="px-6 py-7 text-ink-soft">Loading…</p>}>{page}</Suspense>;

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
        <Route path="/" element={<HomePage />} />
        <Route path="/diagrams" element={<DiagramsPage />} />
        <Route path="/diagram/:id" element={<DiagramEditorPage />} />
        <Route path="/component/:id" element={<ComponentTreePage />} />
        <Route path="/model" element={<ModelPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/analysis" element={<AnalysisPage />} />
        <Route path="/impact" element={<ImpactPage />} />
        <Route path="/map" element={<MapPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/ask" element={<AskPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/checks" element={<ChecksPage />} />
        <Route path="/checks/rules" element={<RulesPage />} />
        <Route path="/document" element={<DocumentPage />} />
        <Route path="/decisions" element={<DecisionsPage />} />
        <Route path="/decisions/:id" element={<DecisionsPage />} />
        <Route path="/processes" element={later(<ProcessesPage />)} />
        <Route path="/processes/:id" element={later(<ProcessPage />)} />
        <Route path="/process-mining" element={later(<MiningPage />)} />
        <Route path="/bpmn-library" element={later(<BpmnLibraryPage />)} />
        <Route path="/ai" element={<AiInboxPage />} />
        <Route path="/ai/:id" element={<ProposalReviewPage />} />
        {cloudEnabled && (
          <>
            <Route path="/versions" element={<VersionsPage />} />
            <Route path="/versions/:id" element={<VersionPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
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
      {/* A verified copy of a diagram: anyone with the link or its code checks it, without signing in. */}
      {cloudEnabled && <Route path="/verify/:token" element={<VerifyPage />} />}
      {/* With a hosted backend, everything else waits for sign-in and an open workspace. */}
      {/* Presenting shows one diagram with nothing around it; it still needs the workspace, so it waits for sign-in too. */}
      <Route path="/present/:id" element={cloudEnabled ? <CloudGate><PresentPage /></CloudGate> : <PresentPage />} />
      <Route path="*" element={cloudEnabled ? <CloudGate>{app}</CloudGate> : app} />
    </Routes>
  );
}
