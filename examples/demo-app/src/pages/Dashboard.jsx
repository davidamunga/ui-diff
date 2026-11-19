import Card from '../components/Card.jsx';
import Stat from '../components/Stat.jsx';

const stats = [
  { label: 'Active sensors', value: '18', delta: 12 },
  { label: 'Alerts this week', value: '4', delta: -33 },
  { label: 'Highest tide', value: '2.4 m', delta: 5 },
  { label: 'Uptime', value: '99.8%', delta: 0.2 },
];

const levels = [1.2, 1.6, 2.1, 2.4, 2.0, 1.4, 0.9, 0.7, 1.0, 1.5, 1.9, 2.2];

const readings = [
  { station: 'North Pier', level: '2.1 m', status: 'Rising', time: '09:40' },
  { station: 'Harbor Mouth', level: '1.8 m', status: 'Steady', time: '09:38' },
  { station: 'Kelp Point', level: '2.4 m', status: 'Alert', time: '09:35' },
  { station: 'Lighthouse', level: '1.2 m', status: 'Falling', time: '09:31' },
];

export default function Dashboard() {
  const max = Math.max(...levels);
  return (
    <section className="container section">
      <div className="page-head page-head-row">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Bay Area stations · last 12 hours</p>
        </div>
        <button className="button button-ghost">Export CSV</button>
      </div>
      <div className="grid grid-4">
        {stats.map((s) => <Stat key={s.label} {...s} />)}
      </div>
      <div className="grid grid-2-1 section-tight">
        <Card title="Water level (m)">
          <div className="bars" role="img" aria-label="Water level over the last 12 hours">
            {levels.map((v, i) => (
              <div key={i} className="bar" style={{ height: `${(v / max) * 100}%` }} title={`${v} m`} />
            ))}
          </div>
        </Card>
        <Card title="Notes">
          <p>Spring tide expected Thursday. Kelp Point gauge was recalibrated on Monday.</p>
        </Card>
      </div>
      <Card title="Latest readings">
        <table className="table">
          <thead>
            <tr><th>Station</th><th>Level</th><th>Status</th><th>Time</th></tr>
          </thead>
          <tbody>
            {readings.map((r) => (
              <tr key={r.station}>
                <td>{r.station}</td>
                <td>{r.level}</td>
                <td><span className={`pill pill-${r.status.toLowerCase()}`}>{r.status}</span></td>
                <td className="muted">{r.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}
