import { createBrowserRouter } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Home from './pages/Home.jsx';
import Pricing from './pages/Pricing.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Settings from './pages/Settings.jsx';

// Plain string paths, so ui-diff's routes.cjs can map changed files to these pages.
export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'pricing', element: <Pricing /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
]);
