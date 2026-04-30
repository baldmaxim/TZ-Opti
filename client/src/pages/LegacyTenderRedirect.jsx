import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import TenderOverview from './TenderOverview';

const SETUP_SUBS = new Set(['documents', 'checklist', 'conditions', 'risks', 'qa']);

function legacyTarget(id, block, sub) {
  if (block === 'input') {
    if (sub && SETUP_SUBS.has(sub)) return `/tenders/${id}/setup/${sub}`;
    return `/tenders/${id}/setup/documents`;
  }
  if (block === 'analysis') {
    return `/tenders/${id}/analysis`;
  }
  if (block === 'result') {
    if (sub === 'export') return `/tenders/${id}/export`;
    return `/tenders/${id}/review`;
  }
  return null;
}

export default function LegacyTenderRedirect() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const block = params.get('block');
  const sub = params.get('sub');

  useEffect(() => {
    if (!block) return;
    const target = legacyTarget(id, block, sub);
    if (target) navigate(target, { replace: true });
  }, [id, block, sub, navigate]);

  if (block) return null;
  return <TenderOverview />;
}
