import Card from '../components/Card.jsx';

const plans = [
  { name: 'Starter', price: '$0', period: '/month', features: ['3 sensors', '7 days of history', 'Email alerts'], cta: 'Start free' },
  { name: 'Crew', price: '$24', period: '/month', features: ['25 sensors', '1 year of history', 'SMS + email alerts', 'Shared dashboards'], cta: 'Start trial', highlight: true },
  { name: 'Harbor', price: '$99', period: '/month', features: ['Unlimited sensors', 'Full history', 'Priority support', 'SSO'], cta: 'Contact sales' },
];

const faqs = [
  { q: 'Can I change plans later?', a: 'Yes. Upgrades apply right away and downgrades at the end of the billing period.' },
  { q: 'Which sensors are supported?', a: 'Any gauge that reports over HTTP or MQTT, plus the public NOAA and EMODnet feeds.' },
];

export default function Pricing() {
  return (
    <section className="container section">
      <div className="page-head">
        <h1>Simple pricing</h1>
        <p className="lead">Pay for the sensors you watch. Every plan includes the full dashboard.</p>
      </div>
      <div className="grid grid-3 pricing">
        {plans.map((p) => (
          <Card
            key={p.name}
            title={p.name}
            highlight={p.highlight}
            footer={<button className={p.highlight ? 'button button-block' : 'button button-ghost button-block'}>{p.cta}</button>}
          >
            {p.highlight && <span className="badge">Most popular</span>}
            <div className="price">
              {p.price}
              <span className="price-period">{p.period}</span>
            </div>
            <ul className="checklist">
              {p.features.map((f) => <li key={f}>{f}</li>)}
            </ul>
          </Card>
        ))}
      </div>
      <div className="faq">
        <h2 className="section-title">Questions</h2>
        {faqs.map((f) => (
          <details key={f.q} className="faq-item">
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
