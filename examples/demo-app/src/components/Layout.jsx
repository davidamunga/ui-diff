import { NavLink, Outlet } from 'react-router-dom';
import Logo from './Logo.jsx';

const links = [
  { to: '/', label: 'Home', end: true },
  { to: '/pricing', label: 'Pricing' },
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout() {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="container topbar-inner">
          <NavLink to="/" className="brand" aria-label="Tidepool home">
            <Logo />
            <span>Tidepool</span>
          </NavLink>
          <nav className="nav" aria-label="Main">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} className="nav-link">
                {l.label}
              </NavLink>
            ))}
          </nav>
          <a className="button button-small" href="/pricing">Start free</a>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="footer">
        <div className="container footer-inner">
          <span>© 2026 Tidepool Labs. A demo app for ui-diff.</span>
          <span className="muted">Made with React + Vite</span>
        </div>
      </footer>
    </div>
  );
}
