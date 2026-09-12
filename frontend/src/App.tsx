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
import Quality from './pages/Quality';
import NcrDetail from './pages/NcrDetail';
import CapaDetail from './pages/CapaDetail';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Rfqs from './pages/Rfqs';
import RfqDetail from './pages/RfqDetail';
import Suppliers from './pages/Suppliers';
import UsersAdmin from './pages/UsersAdmin';
import AttributeDefsAdmin from './pages/AttributeDefsAdmin';
import ErpExchange from './pages/ErpExchange';
import Configurator from './pages/Configurator';
import Analytics from './pages/Analytics';
import IntegrationAdmin from './pages/IntegrationAdmin';
import SignatureRequirementsAdmin from './pages/SignatureRequirementsAdmin';
import BuildUnits from './pages/BuildUnits';
import BuildUnitDetail from './pages/BuildUnitDetail';
import Traceability from './pages/Traceability';
import CatalogImports from './pages/CatalogImports';
import CatalogImportDetail from './pages/CatalogImportDetail';
import CatalogMappingsAdmin from './pages/CatalogMappingsAdmin';
import ServiceRecords from './pages/ServiceRecords';
import Materials from './pages/Materials';
import AccessGroupsAdmin from './pages/AccessGroupsAdmin';
import ServiceRecordDetail from './pages/ServiceRecordDetail';
import PortalLayout from './pages/portal/PortalLayout';
import PortalLogin from './pages/portal/PortalLogin';
import PortalAcceptInvite from './pages/portal/PortalAcceptInvite';
import PortalRfqs from './pages/portal/PortalRfqs';
import PortalRfqDetail from './pages/portal/PortalRfqDetail';

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
      {/* Supplier portal: outside RequireAuth and AppLayout entirely, so no PLM chrome or
          internal session is ever involved. */}
      <Route path="/portal/login" element={<PortalLogin />} />
      <Route path="/portal/accept-invite" element={<PortalAcceptInvite />} />
      <Route element={<PortalLayout />}>
        <Route path="/portal" element={<PortalRfqs />} />
        <Route path="/portal/rfqs/:id" element={<PortalRfqDetail />} />
      </Route>

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
        <Route path="/quality" element={<Quality />} />
        <Route path="/ncrs/:id" element={<NcrDetail />} />
        <Route path="/capas/:id" element={<CapaDetail />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/rfqs" element={<Rfqs />} />
        <Route path="/rfqs/:id" element={<RfqDetail />} />
        <Route path="/suppliers" element={<Suppliers />} />
        <Route path="/build-units" element={<BuildUnits />} />
        <Route path="/build-units/:id" element={<BuildUnitDetail />} />
        <Route path="/traceability" element={<Traceability />} />
        <Route path="/catalog-imports" element={<CatalogImports />} />
        <Route path="/catalog-imports/:id" element={<CatalogImportDetail />} />
        <Route path="/materials" element={<Materials />} />
        <Route path="/service" element={<ServiceRecords />} />
        <Route path="/service/:id" element={<ServiceRecordDetail />} />
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
        <Route
          path="/admin/catalog-mappings"
          element={
            <RequireAdmin>
              <CatalogMappingsAdmin />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/access-groups"
          element={
            <RequireAdmin>
              <AccessGroupsAdmin />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/signatures"
          element={
            <RequireAdmin>
              <SignatureRequirementsAdmin />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
