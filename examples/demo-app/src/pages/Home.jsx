import { Link } from 'react-router-dom';
import Card from '../components/Card.jsx';

const features = [
  { title: 'Live tide charts', body: 'See every sensor on the coast update in real time, down to the minute.' },
  { title: 'Smart alerts', body: 'Get a message before the water reaches the threshold you care about.' },
  { title: 'Team spaces', body: 'Share dashboards with your crew and keep notes next to the data.' },
];

export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="container hero-inner">
          <p className="eyebrow">Coastal monitoring for small teams</p>
          <h1>Know the water before you get there.</h1>
          <p className="lead">
            Tidepool collects readings from tide gauges and buoys and turns them into one calm, clear view.
          </p>
          <div className="hero-actions">
            <Link className="button" to="/pricing">See pricing</Link>
            <Link className="button button-ghost" to="/dashboard">Open the demo dashboard</Link>
          </div>
        </div>
      </section>
      <section className="container section">
        <h2 className="section-title">Everything in one place</h2>
        <div className="grid grid-3">
          {features.map((f) => (
            <Card key={f.title} title={f.title}>
              <p>{f.body}</p>
            </Card>
          ))}
        </div>
      </section>
      <section className="container section">
        <div className="cta">
          <div>
            <h2>Try it with your own stations</h2>
            <p className="muted">Free for up to three sensors. No card needed.</p>
          </div>
          <Link className="button" to="/settings">Connect a station</Link>
        </div>
      </section>
    </>
  );
}
