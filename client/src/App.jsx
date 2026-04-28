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
import ReviewPage from './pages/result/ReviewPage';
import ExportPage from './pages/result/ExportPage';

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
          <Route path="stage/:n" element={<StagePage />} />
          <Route path="review" element={<ReviewPage />} />
          <Route path="export" element={<ExportPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
