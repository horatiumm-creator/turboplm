import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth, useAuth } from './auth/AuthContext';
import AppLayout from './components/AppLayout';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import MyWork from './pages/MyWork';
import PartsList from './pages/PartsList';
import PartDetail from './pages/PartDetail';
import EcnList from './pages/EcnList';
import EcnDetail from './pages/EcnDetail';
import EcnReport from './pages/EcnReport';
import BomCompare from './pages/BomCompare';
import RequirementsList from './pages/RequirementsList';
import RequirementDetail from './pages/RequirementDetail';
import WorkflowsAdmin from './pages/WorkflowsAdmin';
import EmailAdmin from './pages/EmailAdmin';
import DocumentsList from './pages/DocumentsList';
import DocumentDetail from './pages/DocumentDetail';
import EcrList from './pages/EcrList';
import EcrDetail from './pages/EcrDetail';
import Baselines from './pages/Baselines';
import Activity from './pages/Activity';
import UsersAdmin from './pages/UsersAdmin';
import AttributeDefsAdmin from './pages/AttributeDefsAdmin';
import ErpExchange from './pages/ErpExchange';
import Configurator from './pages/Configurator';
import Analytics from './pages/Analytics';
import IntegrationAdmin from './pages/IntegrationAdmin';

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'ADMIN') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route
        path="/ecns/:id/report"
        element={
          <RequireAuth>
            <EcnReport />
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/my-work" element={<MyWork />} />
        <Route path="/parts" element={<PartsList />} />
        <Route path="/parts/:id" element={<PartDetail />} />
        <Route path="/ecns" element={<EcnList />} />
        <Route path="/ecns/:id" element={<EcnDetail />} />
        <Route path="/compare" element={<BomCompare />} />
        <Route path="/requirements" element={<RequirementsList />} />
        <Route path="/requirements/:id" element={<RequirementDetail />} />
        <Route
          path="/admin/workflows"
          element={
            <RequireAdmin>
              <WorkflowsAdmin />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/email"
          element={
            <RequireAdmin>
              <EmailAdmin />
            </RequireAdmin>
          }
        />
        <Route path="/documents" element={<DocumentsList />} />
        <Route path="/documents/:id" element={<DocumentDetail />} />
        <Route path="/ecrs" element={<EcrList />} />
        <Route path="/ecrs/:id" element={<EcrDetail />} />
        <Route path="/baselines" element={<Baselines />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/erp" element={<ErpExchange />} />
        <Route path="/configure" element={<Configurator />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route
          path="/admin/users"
          element={
            <RequireAdmin>
              <UsersAdmin />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/attributes"
          element={
            <RequireAdmin>
              <AttributeDefsAdmin />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/integration"
          element={
            <RequireAdmin>
              <IntegrationAdmin />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
