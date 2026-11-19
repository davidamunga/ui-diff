export default function Stat({ label, value, delta }) {
  const up = delta >= 0;
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className={up ? 'stat-delta up' : 'stat-delta down'}>
        {up ? '▲' : '▼'} {Math.abs(delta)}% vs last week
      </div>
    </div>
  );
}
