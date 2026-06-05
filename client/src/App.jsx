import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/layout/Layout';
import DashboardPage from './pages/DashboardPage';
import TenderShell from './components/layout/TenderShell';
import LegacyTenderRedirect from './pages/LegacyTenderRedirect';
import DocumentsPage from './pages/setup/DocumentsPage';
import ChecklistPage from './pages/setup/ChecklistPage';
import ConditionsPage from './pages/setup/ConditionsPage';
import RisksPage from './pages/setup/RisksPage';
import QaPage from './pages/setup/QaPage';
import StagePage from './pages/stages/StagePage';
import AnalysisOverview from './pages/analysis/AnalysisOverview';
import SummaryPage from './pages/result/SummaryPage';
import ReviewPage from './pages/result/ReviewPage';
import ExportPage from './pages/result/ExportPage';
import SignalsPage from './pages/debug/SignalsPage';
import DraftIssuesPage from './pages/debug/DraftIssuesPage';
import IssueReviewsPage from './pages/debug/IssueReviewsPage';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />

        <Route path="/tenders/:id" element={<TenderShell />}>
          <Route index element={<LegacyTenderRedirect />} />
          <Route path="setup/documents" element={<DocumentsPage />} />
          <Route path="setup/checklist" element={<ChecklistPage />} />
          <Route path="setup/conditions" element={<ConditionsPage />} />
          <Route path="setup/risks" element={<RisksPage />} />
          <Route path="setup/qa" element={<QaPage />} />
          <Route path="analysis" element={<AnalysisOverview />} />
          <Route path="stage/:n" element={<StagePage />} />
          <Route path="summary" element={<SummaryPage />} />
          <Route path="review" element={<ReviewPage />} />
          <Route path="export" element={<ExportPage />} />
          <Route path="debug/signals" element={<SignalsPage />} />
          <Route path="debug/draft-issues" element={<DraftIssuesPage />} />
          <Route path="debug/issue-reviews" element={<IssueReviewsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
